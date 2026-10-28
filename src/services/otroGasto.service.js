import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { compressImage } from "../utils/imageProcessor.js";
import { romeDay } from "../utils/romeTime.js";
import { findVehicleByTarga } from "../models/multa.model.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Otros gastos del chofer: compras que no son combustible ni peajes (aceite, liquido refrigerante, lavado...). Los carga el propio chofer (o el
// Admin/Owner en su modo chofer) con su comprobante y la oficina los marca como reembolsados o los rechaza con una nota.
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 60;

const isOffice = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const CONCEPTO_LABEL = {
  ACEITE: "Aceite",
  REFRIGERANTE: "Liquido refrigerante",
  LAVADO: "Lavado",
  NEUMATICOS: "Neumaticos",
  REPUESTO: "Repuesto",
  OTRO: "Otro",
};

const person = (u) => (u ? { id: u.id, nombre: u.nombre, apellido: u.apellido } : null);
const INCLUDE = {
  driver: { select: { id: true, nombre: true, apellido: true } },
  vehicle: { select: { id: true, targa: true, modelo: true } },
  revisadoPor: { select: { id: true, nombre: true, apellido: true } },
};

const toResponse = async (g) => ({
  id: g.id,
  driver: person(g.driver),
  concepto: g.concepto,
  conceptoLabel: CONCEPTO_LABEL[g.concepto] ?? g.concepto,
  descripcion: g.descripcion,
  monto: Number(g.monto),
  fecha: g.fecha.toISOString().slice(0, 10),
  vehiculo: g.vehicle ? { id: g.vehicle.id, targa: g.vehicle.targa, modelo: g.vehicle.modelo } : null,
  comprobante: g.comprobanteKey ? { url: await getSignedUrlForKey(g.comprobanteKey), esPdf: g.comprobanteKey.endsWith(".pdf") } : null,
  estado: g.estado,
  nota: g.nota,
  revisadoAt: g.revisadoAt,
  revisadoPor: person(g.revisadoPor),
  creadoAt: g.createdAt,
});

const uploadComprobante = async (id, file) => {
  const isPdf = file.mimetype === "application/pdf";
  const buffer = isPdf ? file.buffer : await compressImage(file.buffer);
  const key = `otros-gastos/${id}/comprobante-${Date.now()}-${randomUUID()}.${isPdf ? "pdf" : "webp"}`;
  await uploadObject(key, buffer, isPdf ? "application/pdf" : "image/webp");
  return key;
};

// El gasto no puede ser de un dia futuro ni de hace mas de MAX_AGE_DAYS dias (hora de Roma).
const assertFecha = (fecha) => {
  const today = romeDay();
  if (fecha > today) throw new AppError("La fecha no puede ser futura", 400, { fecha: ["No puede ser futura"] });
  const oldest = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  if (fecha < oldest) throw new AppError(`Solo se pueden cargar gastos de los ultimos ${MAX_AGE_DAYS} dias`, 400, { fecha: ["Demasiado antigua"] });
};

const resolveVehicleId = async (targa) => {
  if (!targa) return null;
  const vehicle = await findVehicleByTarga(targa.replace(/\s+/g, "").toUpperCase());
  if (!vehicle) throw new AppError("Esa targa no esta en la flota", 400, { targa: ["No esta en la flota"] });
  return vehicle.id;
};

const dateOnly = (fecha) => new Date(`${fecha}T00:00:00.000Z`);

export const createOtroGastoForActor = async (actor, data, file) => {
  if (actor.cargo !== "CHOFER" && !isOffice(actor)) throw new AppError("Solo los choferes cargan sus gastos", 403);
  assertFecha(data.fecha);
  const vehicleId = await resolveVehicleId(data.targa);
  const id = randomUUID();
  const comprobanteKey = file ? await uploadComprobante(id, file) : null;
  try {
    const created = await prisma.otroGasto.create({
      data: {
        id,
        driverId: actor.id,
        vehicleId,
        concepto: data.concepto,
        descripcion: data.descripcion ?? null,
        monto: data.monto,
        fecha: dateOnly(data.fecha),
        comprobanteKey,
      },
      include: INCLUDE,
    });
    return toResponse(created);
  } catch (err) {
    if (comprobanteKey) await deleteObject(comprobanteKey).catch(() => {});
    throw err;
  }
};

const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
};

// El chofer ve los suyos; la oficina, los de todos (puede filtrar por chofer, estado y mes).
export const listOtrosGastosForActor = async (actor, { estado, driverId, month } = {}) => {
  const where = { ...(estado ? { estado } : {}), ...(month ? { fecha: monthRange(month) } : {}) };
  if (isOffice(actor)) {
    if (driverId) where.driverId = driverId;
  } else where.driverId = actor.id;

  const rows = await prisma.otroGasto.findMany({ where, include: INCLUDE, orderBy: [{ fecha: "desc" }, { createdAt: "desc" }], take: 300 });
  const items = await Promise.all(rows.map(toResponse));
  // Lo que se debe reembolsar o ya se reembolso (un rechazado no cuenta).
  const total = Math.round(items.filter((g) => g.estado !== "RECHAZADO").reduce((sum, g) => sum + g.monto, 0) * 100) / 100;
  const pendientes = isOffice(actor) ? await prisma.otroGasto.count({ where: { estado: "PENDIENTE" } }) : null;
  return { items, total, pendientes };
};

const loadFor = async (actor, id) => {
  const g = await prisma.otroGasto.findUnique({ where: { id }, include: INCLUDE });
  if (!g) throw new AppError("Gasto no encontrado", 404);
  if (!isOffice(actor) && g.driverId !== actor.id) throw new AppError("No tienes permisos para realizar esta accion", 403);
  return g;
};

// Corregir o borrar es solo de quien lo cargo, y mientras no este reembolsado (un rechazado se corrige y vuelve a quedar pendiente).
const assertEditable = (actor, g) => {
  if (g.driverId !== actor.id) throw new AppError("Solo quien lo cargo puede cambiarlo", 403);
  if (g.estado === "REEMBOLSADO") throw new AppError("Un gasto reembolsado ya no se puede cambiar", 409);
};

export const updateOtroGastoForActor = async (actor, id, data, file) => {
  const current = await loadFor(actor, id);
  assertEditable(actor, current);
  assertFecha(data.fecha);
  const vehicleId = await resolveVehicleId(data.targa);
  const newKey = file ? await uploadComprobante(id, file) : null;
  const quitar = current.comprobanteKey && (newKey || data.quitarComprobante) ? current.comprobanteKey : null;
  const updated = await prisma.otroGasto.update({
    where: { id },
    data: {
      vehicleId,
      concepto: data.concepto,
      descripcion: data.descripcion ?? null,
      monto: data.monto,
      fecha: dateOnly(data.fecha),
      comprobanteKey: newKey ?? (quitar ? null : current.comprobanteKey),
      estado: "PENDIENTE",
      nota: null,
      revisadoAt: null,
      revisadoPorId: null,
    },
    include: INCLUDE,
  });
  if (quitar) await deleteObject(quitar).catch(() => {});
  return toResponse(updated);
};

export const deleteOtroGastoForActor = async (actor, id) => {
  const current = await loadFor(actor, id);
  assertEditable(actor, current);
  await prisma.otroGasto.delete({ where: { id } });
  if (current.comprobanteKey) await deleteObject(current.comprobanteKey).catch(() => {});
};

// La oficina marca un gasto como reembolsado o lo rechaza con el motivo; el chofer recibe el aviso.
export const reviewOtroGastoForActor = async (actor, id, { accion, nota }) => {
  if (!isOffice(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
  const current = await loadFor(actor, id);
  const reembolsar = accion === "REEMBOLSAR";
  const updated = await prisma.otroGasto.update({
    where: { id },
    data: { estado: reembolsar ? "REEMBOLSADO" : "RECHAZADO", nota: nota ?? null, revisadoAt: new Date(), revisadoPorId: actor.id },
    include: INCLUDE,
  });
  sendPushToUserIds([current.driverId], {
    title: reembolsar ? "Gasto reembolsado" : "Gasto rechazado",
    body: reembolsar
      ? `Tu gasto de ${CONCEPTO_LABEL[current.concepto] ?? current.concepto} (${Number(current.monto).toFixed(2)} EUR) fue reembolsado.`
      : `Tu gasto de ${CONCEPTO_LABEL[current.concepto] ?? current.concepto} fue rechazado: ${nota}`,
    data: { type: "otro-gasto", gastoId: id },
  }).catch((err) => console.error("No se pudo avisar del otro gasto:", err.message));
  return toResponse(updated);
};
