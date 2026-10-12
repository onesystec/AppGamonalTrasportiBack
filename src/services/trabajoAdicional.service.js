import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { actorAreaKeys } from "../utils/areaAccess.js";
import { compressImage } from "../utils/imageProcessor.js";
import { computeShiftHours } from "../utils/workHours.js";
import { findOfficeUserIdsForArea } from "../models/user.model.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { findVehicleByTarga } from "../models/multa.model.js";

// Trabajos adicionales: tareas fuera de los servicios (por ejemplo en Farmacia) que carga el propio chofer y aprueba el responsable del
// area. Solo los aprobados cuentan en sus horas y en su paga (ver getPagosChoferesForActor).
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 30;

const isOffice = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

// Clave de area de servicio (la de User.areasPermitidas) que decide que Responsable lo ve.
const areaKeyFor = (areaTipo, zona) => {
  if (areaTipo === "DHL") return zona === "ROMA" ? "dhl-roma" : "dhl-milano";
  if (areaTipo === "EXTRAS") return zona === "ROMA" ? "piazza-roma" : "piazza-milano";
  return "otros"; // Farmacia y Otros no tienen servicios propios
};

const AREA_LABEL = { DHL: "DHL", EXTRAS: "Extras", FARMACIA: "Farmacia", OTROS: "Otros" };
const person = (u) => (u ? { id: u.id, nombre: u.nombre, apellido: u.apellido } : null);
const INCLUDE = {
  driver: { select: { id: true, nombre: true, apellido: true } },
  revisadoPor: { select: { id: true, nombre: true, apellido: true } },
};

const toResponse = async (t, avisos = []) => ({
  id: t.id,
  driver: person(t.driver),
  areaTipo: t.areaTipo,
  areaLabel: t.areaTipo === "OTROS" && t.areaOtros ? `Otros: ${t.areaOtros}` : `${AREA_LABEL[t.areaTipo]}${t.zona ? ` ${t.zona === "ROMA" ? "Roma" : "Milano"}` : ""}`,
  zona: t.zona,
  areaOtros: t.areaOtros,
  area: t.area,
  inicio: t.inicio,
  fin: t.fin,
  inicioDeclarado: t.inicioDeclarado,
  finDeclarado: t.finDeclarado,
  ajustado: t.inicio.getTime() !== t.inicioDeclarado.getTime() || t.fin.getTime() !== t.finDeclarado.getTime(),
  pausaMin: t.pausaMin,
  horasDia: t.horasDia,
  horasNoche: t.horasNoche,
  horas: Math.round((t.horasDia + t.horasNoche) * 100) / 100,
  descripcion: t.descripcion,
  solicitadoPor: t.solicitadoPor,
  sinVehiculo: t.sinVehiculo,
  targa: t.targa,
  km: t.km,
  foto: t.fotoKey ? { url: await getSignedUrlForKey(t.fotoKey), esPdf: t.fotoKey.endsWith(".pdf") } : null,
  estado: t.estado,
  nota: t.nota,
  revisadoAt: t.revisadoAt,
  revisadoPor: person(t.revisadoPor),
  creadoAt: t.createdAt, // fecha de creacion: la pone el servidor y no se edita
  avisos,
});

const processFile = async (file) => {
  if (file.mimetype === "application/pdf") return { buffer: file.buffer, mimeType: "application/pdf", ext: "pdf" };
  return { buffer: await compressImage(file.buffer), mimeType: "image/webp", ext: "webp" };
};
const uploadFoto = async (id, file) => {
  const { buffer, mimeType, ext } = await processFile(file);
  const key = `trabajos-adicionales/${id}/foto-${Date.now()}-${randomUUID()}.${ext}`;
  await uploadObject(key, buffer, mimeType);
  return key;
};

// Horas dia/noche del trabajo (misma banda y misma cuenta que las jornadas de los servicios); error 400 si los datos no cierran.
const hoursFor = ({ inicio, fin, pausaMin }) => {
  const shift = computeShiftHours({ inicio, fin, pausaMin });
  if (shift.error) throw new AppError(shift.error, 400, { fin: [shift.error] });
  return { horasDia: shift.horasDia, horasNoche: shift.horasNoche };
};

const assertDates = (inicio, fin) => {
  const now = Date.now();
  if (fin.getTime() > now + 5 * 60 * 1000) throw new AppError("El trabajo no puede terminar en el futuro", 400, { fin: ["No puede ser futura"] });
  if (inicio.getTime() < now - MAX_AGE_DAYS * DAY_MS) {
    throw new AppError(`Solo se pueden cargar trabajos de los ultimos ${MAX_AGE_DAYS} dias`, 400, { inicio: ["Demasiado antigua"] });
  }
};

// Choques con otras horas del mismo chofer (otro trabajo adicional o la jornada de un servicio): se avisa, no se bloquea.
const overlapsFor = async (driverId, inicio, fin, excludeId, { own = true } = {}) => {
  const [trabajos, servicios] = await Promise.all([
    prisma.trabajoAdicional.findMany({
      where: { driverId, id: excludeId ? { not: excludeId } : undefined, estado: { not: "DEVUELTO" }, inicio: { lt: fin }, fin: { gt: inicio } },
      select: { id: true },
    }),
    prisma.record.findMany({
      where: { driverId, estado: { not: "ANNULLATO" }, horaInicioReal: { lt: fin }, horaFinReal: { gt: inicio } },
      select: { codigo: true },
    }),
  ]);
  const avisos = [];
  if (trabajos.length) avisos.push(`Se pisa con otro trabajo adicional ${own ? "tuyo" : "del mismo chofer"} (${trabajos.length}).`);
  if (servicios.length) avisos.push(`Se pisa con la jornada de ${servicios.length === 1 ? "un servicio" : `${servicios.length} servicios`}${own ? "" : " del chofer"} (${servicios.map((s) => s.codigo).join(", ")}): las horas no se pagan dos veces.`);
  return avisos;
};

const resolveVehicle = async (data) => {
  if (data.sinVehiculo) return { vehicleId: null, targa: null, km: null };
  const targa = data.targa.replace(/\s+/g, "").toUpperCase();
  const vehicle = await findVehicleByTarga(targa);
  if (!vehicle) throw new AppError("Esa targa no esta en la flota", 400, { targa: ["No esta en la flota"] });
  return { vehicleId: vehicle.id, targa, km: data.km ?? null };
};

const notifyOffice = (t, chofer, title, body) =>
  findOfficeUserIdsForArea(t.area)
    .then((ids) => sendPushToUserIds(ids, { title, body, data: { type: "trabajo-adicional", trabajoId: t.id } }))
    .catch((err) => console.error("No se pudo avisar del trabajo adicional:", err.message));

export const createTrabajoAdicionalForActor = async (actor, data, file) => {
  if (actor.cargo !== "CHOFER") throw new AppError("Solo los choferes cargan trabajos adicionales", 403);
  const inicio = new Date(data.inicio);
  const fin = new Date(data.fin);
  assertDates(inicio, fin);
  const hours = hoursFor({ inicio, fin, pausaMin: data.pausaMin ?? 0 });
  const vehicle = await resolveVehicle(data);
  const id = randomUUID();
  const fotoKey = file ? await uploadFoto(id, file) : null;
  try {
    const created = await prisma.trabajoAdicional.create({
      data: {
        id,
        driverId: actor.id,
        areaTipo: data.areaTipo,
        zona: data.areaTipo === "DHL" || data.areaTipo === "EXTRAS" ? data.zona : null,
        areaOtros: data.areaTipo === "OTROS" ? data.areaOtros : null,
        area: areaKeyFor(data.areaTipo, data.zona),
        inicio,
        fin,
        inicioDeclarado: inicio,
        finDeclarado: fin,
        pausaMin: data.pausaMin ?? 0,
        ...hours,
        descripcion: data.descripcion,
        solicitadoPor: data.solicitadoPor ?? null,
        sinVehiculo: Boolean(data.sinVehiculo),
        ...vehicle,
        fotoKey,
      },
      include: INCLUDE,
    });
    notifyOffice(created, actor, "Trabajo adicional por aprobar", `${actor.nombre} ${actor.apellido} cargo un trabajo adicional (${AREA_LABEL[created.areaTipo]}).`);
    return toResponse(created, await overlapsFor(actor.id, inicio, fin, id));
  } catch (err) {
    if (fotoKey) await deleteObject(fotoKey).catch(() => {});
    throw err;
  }
};

const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { gte: new Date(Date.UTC(y, m - 1, 1) - 12 * 3600 * 1000), lt: new Date(Date.UTC(y, m, 1) - 12 * 3600 * 1000) };
};

// El chofer ve los suyos; la oficina ve los de sus areas (el Admin, todos) y puede filtrar por estado o chofer.
export const listTrabajosAdicionalesForActor = async (actor, { estado, driverId, month } = {}) => {
  const where = { ...(estado ? { estado } : {}), ...(month ? { inicio: monthRange(month) } : {}) };
  if (isOffice(actor)) {
    const keys = actorAreaKeys(actor);
    if (keys !== null) where.area = { in: keys };
    if (driverId) where.driverId = driverId;
  } else where.driverId = actor.id;

  const rows = await prisma.trabajoAdicional.findMany({ where, include: INCLUDE, orderBy: [{ inicio: "desc" }], take: 300 });
  // Para quien revisa: avisos de choques con servicios o con otros trabajos del chofer.
  const items = await Promise.all(
    rows.map(async (t) => toResponse(t, isOffice(actor) && t.estado === "PENDIENTE" ? await overlapsFor(t.driverId, t.inicio, t.fin, t.id, { own: false }) : []))
  );
  const pendientes = isOffice(actor) ? await prisma.trabajoAdicional.count({ where: { estado: "PENDIENTE", ...(where.area ? { area: where.area } : {}) } }) : null;
  return { items, pendientes };
};

const loadFor = async (actor, id) => {
  const t = await prisma.trabajoAdicional.findUnique({ where: { id }, include: INCLUDE });
  if (!t) throw new AppError("Trabajo adicional no encontrado", 404);
  if (isOffice(actor)) {
    const keys = actorAreaKeys(actor);
    if (keys !== null && !keys.includes(t.area)) throw new AppError("No tienes permisos para realizar esta accion", 403);
  } else if (t.driverId !== actor.id) throw new AppError("No tienes permisos para realizar esta accion", 403);
  return t;
};

// El chofer corrige un trabajo mientras no este aprobado (pendiente o devuelto): vuelve a quedar pendiente.
export const updateTrabajoAdicionalForActor = async (actor, id, data, file) => {
  const current = await loadFor(actor, id);
  if (actor.cargo !== "CHOFER") throw new AppError("Solo el chofer corrige su trabajo", 403);
  if (current.estado === "APROBADO") throw new AppError("Un trabajo aprobado ya no se puede cambiar", 409);
  const inicio = new Date(data.inicio);
  const fin = new Date(data.fin);
  assertDates(inicio, fin);
  const hours = hoursFor({ inicio, fin, pausaMin: data.pausaMin ?? 0 });
  const vehicle = await resolveVehicle(data);
  const fotoKey = file ? await uploadFoto(id, file) : current.fotoKey;
  const updated = await prisma.trabajoAdicional.update({
    where: { id },
    data: {
      areaTipo: data.areaTipo,
      zona: data.areaTipo === "DHL" || data.areaTipo === "EXTRAS" ? data.zona : null,
      areaOtros: data.areaTipo === "OTROS" ? data.areaOtros : null,
      area: areaKeyFor(data.areaTipo, data.zona),
      inicio,
      fin,
      inicioDeclarado: inicio,
      finDeclarado: fin,
      pausaMin: data.pausaMin ?? 0,
      ...hours,
      descripcion: data.descripcion,
      solicitadoPor: data.solicitadoPor ?? null,
      sinVehiculo: Boolean(data.sinVehiculo),
      ...vehicle,
      fotoKey,
      estado: "PENDIENTE",
      nota: null,
      revisadoAt: null,
      revisadoPorId: null,
    },
    include: INCLUDE,
  });
  if (file && current.fotoKey) await deleteObject(current.fotoKey).catch(() => {});
  notifyOffice(updated, actor, "Trabajo adicional por aprobar", `${actor.nombre} ${actor.apellido} corrigio un trabajo adicional.`);
  return toResponse(updated, await overlapsFor(actor.id, inicio, fin, id));
};

export const deleteTrabajoAdicionalForActor = async (actor, id) => {
  const current = await loadFor(actor, id);
  if (actor.cargo !== "CHOFER") throw new AppError("Solo el chofer borra su trabajo", 403);
  if (current.estado === "APROBADO") throw new AppError("Un trabajo aprobado no se puede borrar", 409);
  await prisma.trabajoAdicional.delete({ where: { id } });
  if (current.fotoKey) await deleteObject(current.fotoKey).catch(() => {});
};

// El responsable (o el Admin) aprueba, ajusta los tiempos con una nota, o lo devuelve con un motivo.
export const reviewTrabajoAdicionalForActor = async (actor, id, body) => {
  if (!isOffice(actor)) throw new AppError("Solo la oficina revisa los trabajos adicionales", 403);
  const current = await loadFor(actor, id);
  const data = { revisadoAt: new Date(), revisadoPorId: actor.id, nota: body.nota ?? null };
  if (body.accion === "DEVOLVER") data.estado = "DEVUELTO";
  else {
    const inicio = body.inicio ? new Date(body.inicio) : current.inicio;
    const fin = body.fin ? new Date(body.fin) : current.fin;
    Object.assign(data, { estado: "APROBADO", inicio, fin, ...hoursFor({ inicio, fin, pausaMin: current.pausaMin }) });
  }
  const updated = await prisma.trabajoAdicional.update({ where: { id }, data, include: INCLUDE });
  sendPushToUserIds([updated.driverId], {
    title: updated.estado === "APROBADO" ? "Trabajo adicional aprobado" : "Trabajo adicional devuelto",
    body: updated.estado === "APROBADO" ? "Ya cuenta en tus horas." : `Corrige: ${updated.nota}`,
    data: { type: "trabajo-adicional", trabajoId: id },
  }).catch((err) => console.error("No se pudo avisar al chofer:", err.message));
  return toResponse(updated);
};

// Para Pago a choferes: lo aprobado de un mes por chofer { horasDia, horasNoche, count }.
export const approvedByDriverForMonth = async (month, { driverId, areaKeys } = {}) => {
  const rows = await prisma.trabajoAdicional.findMany({
    where: { estado: "APROBADO", inicio: monthRange(month), ...(driverId ? { driverId } : {}), ...(areaKeys ? { area: { in: areaKeys } } : {}) },
    select: { driverId: true, horasDia: true, horasNoche: true, driver: { select: { nombre: true, apellido: true } } },
  });
  const map = new Map();
  for (const r of rows) {
    const e = map.get(r.driverId) ?? { driverId: r.driverId, nombre: `${r.driver.nombre} ${r.driver.apellido}`, horasDia: 0, horasNoche: 0, count: 0 };
    e.horasDia += r.horasDia;
    e.horasNoche += r.horasNoche;
    e.count += 1;
    map.set(r.driverId, e);
  }
  return map;
};
