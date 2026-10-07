import { randomUUID } from "node:crypto";
import {
  countActiveChoferes,
  countCombustibles,
  createCombustible as createCombustibleRecord,
  deleteCombustibleById,
  findCombustibleById,
  findCombustibles,
  findCombustiblesForStats,
  findMetodoUsage,
  findVehicleByTarga,
  sumCombustibleMonto,
  updateCombustibleById,
} from "../models/combustible.model.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { AppError } from "../utils/AppError.js";
import { AREA_VALUES } from "../validators/combustible.validator.js";

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const romeDay = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const dayToDate = (day) => new Date(`${day}T00:00:00.000Z`);
const dateOnlyToDay = (date) => date.toISOString().slice(0, 10);

// Un nombre de gasolinera con espacios de mas no es otra gasolinera.
const cleanMetodo = (value) => value.replace(/\s+/g, " ").trim();

// El chofer ve solo lo suyo; OWNER/ADMIN ven todo y pueden filtrar por chofer.
const buildWhere = (actor, filters) => {
  const and = [];
  if (!isPrivileged(actor)) and.push({ driverId: actor.id });
  else if (filters.driverId) and.push({ driverId: filters.driverId });

  if (filters.area) and.push({ area: filters.area });
  if (filters.targa) {
    and.push({ targa: { contains: filters.targa.replace(/\s+/g, "").toUpperCase() } });
  }
  if (filters.metodo) and.push({ metodo: { equals: cleanMetodo(filters.metodo), mode: "insensitive" } });
  if (filters.from) and.push({ fecha: { gte: dayToDate(filters.from) } });
  if (filters.to) and.push({ fecha: { lte: dayToDate(filters.to) } });
  if (filters.q) {
    const q = filters.q;
    and.push({
      OR: [
        { targa: { contains: q.replace(/\s+/g, ""), mode: "insensitive" } },
        { metodo: { contains: q, mode: "insensitive" } },
        { driver: { is: { nombre: { contains: q, mode: "insensitive" } } } },
        { driver: { is: { apellido: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
};

const assertAccess = (actor, registro) => {
  if (isPrivileged(actor) || registro.driverId === actor.id) return;
  throw new AppError("No tienes permisos para realizar esta accion", 403);
};

// El chofer puede corregir (o borrar) lo que cargo, pero solo el mismo dia en que lo
// registro: despues queda cerrado para que el gasto no se pueda reescribir. OWNER/ADMIN
// pueden siempre.
const canModify = (actor, registro, today) =>
  isPrivileged(actor) || romeDay(registro.createdAt) === today;

const assertCanModify = (actor, registro) => {
  if (!canModify(actor, registro, romeDay())) {
    throw new AppError(
      "Este registro ya se cerro: solo se puede corregir el mismo dia en que se cargo. Pidelo a un administrador.",
      403
    );
  }
};

// PDFs tal cual; imagenes comprimidas y normalizadas a webp (mismo criterio que
// document.service.js y recordFile.service.js).
const processFile = async (file) => {
  if (file.mimetype === "application/pdf") {
    return { buffer: file.buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  const buffer = await compressImage(file.buffer);
  return { buffer, mimeType: "image/webp", ext: "webp" };
};

const buildKey = (id, ext) => `combustible/${id}/comprobante-${Date.now()}-${randomUUID()}.${ext}`;

const uploadComprobante = async (id, file) => {
  const { buffer, mimeType, ext } = await processFile(file);
  const key = buildKey(id, ext);
  await uploadObject(key, buffer, mimeType);
  return key;
};

const person = (p) => (p ? { id: p.id, nombre: p.nombre, apellido: p.apellido } : null);

// El bucket es privado: la respuesta lleva URLs firmadas frescas, nunca la key interna.
const toResponse = async (r, actor, today) => ({
  id: r.id,
  targa: r.targa,
  vehicleId: r.vehicleId,
  driver: person(r.driver),
  registradoPor: person(r.createdBy),
  fecha: r.fecha,
  monto: Number(r.monto),
  metodo: r.metodo,
  area: r.area,
  comprobante: r.comprobanteKey
    ? { url: await getSignedUrlForKey(r.comprobanteKey), esPdf: r.comprobanteKey.endsWith(".pdf") }
    : null,
  // Fecha y hora reales de registro: la pone el sistema, no se puede editar.
  registradoAt: r.createdAt,
  updatedAt: r.updatedAt,
  // Lo calcula el backend para que el front no tenga que repetir la regla.
  editable: canModify(actor, r, today),
});

const resolveDriverId = (actor, requestedDriverId) => {
  if (!isPrivileged(actor)) return actor.id;
  if (!requestedDriverId) throw new AppError("Elige el chofer de la carga", 400);
  return requestedDriverId;
};

export const createCombustibleForActor = async (actor, data, files) => {
  const comprobanteFile = files?.comprobante?.[0];
  if (!comprobanteFile) throw new AppError("El comprobante de pago es obligatorio", 400);
  const driverId = resolveDriverId(actor, data.driverId);

  const id = randomUUID();
  const comprobanteKey = await uploadComprobante(id, comprobanteFile);
  try {
    const vehicle = await findVehicleByTarga(data.targa);
    const created = await createCombustibleRecord({
      id,
      targa: data.targa,
      vehicleId: vehicle?.id ?? null,
      driverId,
      createdById: actor.id,
      fecha: dayToDate(data.fecha),
      monto: data.monto,
      metodo: cleanMetodo(data.metodo),
      area: data.area,
      comprobanteKey,
    });
    return toResponse(created, actor, romeDay());
  } catch (err) {
    await deleteObject(comprobanteKey).catch(() => {});
    throw err;
  }
};

const ORDER_BY_ORDEN = {
  recientes: [{ fecha: "desc" }, { createdAt: "desc" }],
  antiguos: [{ fecha: "asc" }, { createdAt: "asc" }],
  monto: [{ monto: "desc" }, { createdAt: "desc" }],
};

export const listCombustibleForActor = async (actor, query) => {
  const where = buildWhere(actor, query);
  const { page, pageSize } = query;

  const [total, rows] = await Promise.all([
    countCombustibles(where),
    findCombustibles({
      where,
      orderBy: ORDER_BY_ORDEN[query.orden] ?? ORDER_BY_ORDEN.recientes,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const today = romeDay();
  const items = await Promise.all(rows.map((r) => toResponse(r, actor, today)));
  return { items, total, page, pageSize };
};

// Cantidad y total en plata por area, respetando los filtros (menos el de area):
// encabezado de cada acordeon sin traer las filas.
export const getCombustibleSummaryForActor = async (actor, query) => {
  const entries = await Promise.all(
    AREA_VALUES.map(async (area) => {
      const where = buildWhere(actor, { ...query, area });
      const [count, total] = await Promise.all([countCombustibles(where), sumCombustibleMonto(where)]);
      return [area, { count, total }];
    })
  );
  return Object.fromEntries(entries);
};

export const getCombustibleForActor = async (actor, id) => {
  const registro = await findCombustibleById(id);
  if (!registro) throw new AppError("Registro de combustible no encontrado", 404);
  assertAccess(actor, registro);
  return toResponse(registro, actor, romeDay());
};

export const updateCombustibleForActor = async (actor, id, data, files) => {
  const current = await findCombustibleById(id);
  if (!current) throw new AppError("Registro de combustible no encontrado", 404);
  assertAccess(actor, current);
  assertCanModify(actor, current);

  const privileged = isPrivileged(actor);
  const payload = {};
  for (const key of ["targa", "monto", "area"]) {
    if (data[key] !== undefined) payload[key] = data[key];
  }
  if (data.metodo !== undefined) payload.metodo = cleanMetodo(data.metodo);
  if (data.fecha) payload.fecha = dayToDate(data.fecha);
  if (data.targa) payload.vehicleId = (await findVehicleByTarga(data.targa))?.id ?? null;
  if (privileged && data.driverId) payload.driverId = data.driverId;

  let uploadedKey = null;
  try {
    if (files?.comprobante?.[0]) {
      uploadedKey = await uploadComprobante(id, files.comprobante[0]);
      payload.comprobanteKey = uploadedKey;
    }

    if (Object.keys(payload).length === 0) return toResponse(current, actor, romeDay());

    const updated = await updateCombustibleById(id, payload);
    if (uploadedKey && current.comprobanteKey) await deleteObject(current.comprobanteKey).catch(() => {});
    return toResponse(updated, actor, romeDay());
  } catch (err) {
    if (uploadedKey) await deleteObject(uploadedKey).catch(() => {});
    throw err;
  }
};

export const deleteCombustibleForActor = async (actor, id) => {
  const registro = await findCombustibleById(id);
  if (!registro) throw new AppError("Registro de combustible no encontrado", 404);
  assertAccess(actor, registro);
  assertCanModify(actor, registro);

  if (registro.comprobanteKey) await deleteObject(registro.comprobanteKey);
  await deleteCombustibleById(id);
};

// Gasolineras ya usadas, de la mas frecuente a la menos. "Eni" y "ENI" cuentan como una
// sola (se queda con la grafia mas usada).
export const listMetodos = async () => {
  const usage = await findMetodoUsage({});
  const merged = new Map();
  for (const row of usage) {
    const key = row.metodo.toLowerCase();
    const entry = merged.get(key) ?? { nombre: row.metodo, count: 0, best: 0 };
    entry.count += row._count._all;
    if (row._count._all > entry.best) {
      entry.best = row._count._all;
      entry.nombre = row.metodo;
    }
    merged.set(key, entry);
  }
  return [...merged.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
    .map(({ nombre, count }) => ({ nombre, count }));
};

const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const SERIES_MONTHS = 6;
const MAX_TOP_CHOFERES = 4;

const round2 = (value) => Math.round(value * 100) / 100;
const pctChange = (current, previous) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

// Estadisticas del encabezado: gasto del mes en curso (comparado con el mismo tramo del mes
// anterior, para que a mitad de mes no parezca que se gasta menos), gasto por area y por
// chofer, y la serie de los ultimos meses. Respeta los filtros menos el rango de fechas.
export const getCombustibleStatsForActor = async (actor, query) => {
  const today = romeDay();
  const [year, month] = today.split("-").map(Number);
  const month0 = month - 1;
  const dayOfMonth = Number(today.slice(8, 10));

  const firstOfSeries = new Date(Date.UTC(year, month0 - (SERIES_MONTHS - 1), 1)).toISOString().slice(0, 10);
  const where = buildWhere(actor, { ...query, from: firstOfSeries, to: today });
  const [rows, totalChoferes] = await Promise.all([
    findCombustiblesForStats(where),
    isPrivileged(actor) ? countActiveChoferes() : Promise.resolve(null),
  ]);

  const items = rows.map((r) => ({
    monto: Number(r.monto),
    day: dateOnlyToDay(r.fecha),
    area: r.area,
    metodo: r.metodo,
    driverId: r.driverId,
    driverName: r.driver ? `${r.driver.nombre} ${r.driver.apellido}` : "Sin chofer",
  }));

  const monthKey = (y, m0) => {
    const ref = new Date(Date.UTC(y, m0, 1));
    return ref.toISOString().slice(0, 7);
  };
  const currentKey = monthKey(year, month0);
  const prevRef = new Date(Date.UTC(year, month0 - 1, 1));
  const prevKey = prevRef.toISOString().slice(0, 7);

  const sum = (list) => round2(list.reduce((total, i) => total + i.monto, 0));
  const inMonth = (key) => items.filter((i) => i.day.startsWith(key));

  const current = inMonth(currentKey);
  const previousSamePeriod = inMonth(prevKey).filter((i) => Number(i.day.slice(8, 10)) <= dayOfMonth);

  const serie = [];
  for (let back = SERIES_MONTHS - 1; back >= 0; back -= 1) {
    const ref = new Date(Date.UTC(year, month0 - back, 1));
    serie.push({
      label: MONTH_LABELS[ref.getUTCMonth()],
      value: sum(inMonth(ref.toISOString().slice(0, 7))),
    });
  }

  const group = (list, keyOf, build) => {
    const map = new Map();
    for (const i of list) {
      const key = keyOf(i);
      const entry = map.get(key) ?? { ...build(i), count: 0, total: 0 };
      entry.count += 1;
      entry.total += i.monto;
      map.set(key, entry);
    }
    return [...map.values()].map((e) => ({ ...e, total: round2(e.total) })).sort((a, b) => b.total - a.total);
  };

  const porArea = group(current, (i) => i.area, (i) => ({ area: i.area }));

  const rankedChoferes = group(
    current,
    (i) => i.driverId ?? "none",
    (i) => ({ driverId: i.driverId, nombre: i.driverName })
  );
  const porChofer = rankedChoferes.slice(0, MAX_TOP_CHOFERES);
  const rest = rankedChoferes.slice(MAX_TOP_CHOFERES);
  if (rest.length > 0) {
    porChofer.push({
      driverId: null,
      nombre: "Otros",
      count: rest.reduce((total, e) => total + e.count, 0),
      total: round2(rest.reduce((total, e) => total + e.total, 0)),
    });
  }

  // Gasolinera mas usada del mes ("Eni" y "ENI" juntas).
  const byMetodo = group(current, (i) => i.metodo.toLowerCase(), (i) => ({ nombre: i.metodo }));
  const gasolineraTop = byMetodo.length > 0 ? byMetodo.sort((a, b) => b.count - a.count || b.total - a.total)[0] : null;

  const totalMes = sum(current);

  return {
    mesLabel: `${MONTH_LABELS[month0]} ${year}`,
    totalMes,
    totalMesDeltaPct: pctChange(totalMes, sum(previousSamePeriod)),
    cargasMes: current.length,
    promedioPorCarga: current.length > 0 ? round2(totalMes / current.length) : 0,
    promedioPorCargaDeltaPct: pctChange(
      current.length > 0 ? totalMes / current.length : 0,
      previousSamePeriod.length > 0 ? sum(previousSamePeriod) / previousSamePeriod.length : 0
    ),
    choferesQueCargaron: new Set(current.map((i) => i.driverId).filter(Boolean)).size,
    totalChoferes,
    gasolineraTop: gasolineraTop ? { nombre: gasolineraTop.nombre, count: gasolineraTop.count } : null,
    porArea,
    porChofer,
    serie,
  };
};
