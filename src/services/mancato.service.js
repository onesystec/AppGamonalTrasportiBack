import { randomUUID } from "node:crypto";
import {
  countActiveChoferes,
  countMancatos,
  createMancato as createMancatoRecord,
  deleteMancatoById,
  findMancatoById,
  findMancatoByNumero,
  findMancatos,
  findMancatosForStats,
  findVehicleByTarga,
  sumMancatosCosto,
  updateMancatoById,
} from "../models/mancato.model.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { AppError } from "../utils/AppError.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Como dicen los avisos ("entro e non oltre il 15° giorno successivo alla data del
// transito"): se puede pagar hasta el dia 15 POSTERIOR a la fecha, o sea fecha + 15. Se
// paga hasta el final de ese ultimo dia.
const PLAZO_DIAS_DESPUES_DE_LA_FECHA = 15;

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const romeDay = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const dayToDate = (day) => new Date(`${day}T00:00:00.000Z`);
const dayDiff = (fromDay, toDay) => Math.round((dayToDate(toDay) - dayToDate(fromDay)) / DAY_MS);
const addDays = (day, days) => new Date(dayToDate(day).getTime() + days * DAY_MS);
const dateOnlyToDay = (date) => date.toISOString().slice(0, 10);

const calcVencimiento = (fechaDay) => addDays(fechaDay, PLAZO_DIAS_DESPUES_DE_LA_FECHA);

// Pendiente / Vencido / Pagado nunca se guardan: se derivan de pagado + fechaVencimiento.
const deriveEstado = (m, today) => {
  if (m.pagado) return "PAGADO";
  return dateOnlyToDay(m.fechaVencimiento) < today ? "VENCIDO" : "PENDIENTE";
};

const estadoWhere = (estado, today) => {
  const todayDate = dayToDate(today);
  if (estado === "PAGADO") return { pagado: true };
  if (estado === "VENCIDO") return { pagado: false, fechaVencimiento: { lt: todayDate } };
  if (estado === "PENDIENTE") return { pagado: false, fechaVencimiento: { gte: todayDate } };
  return {};
};

// El chofer solo ve los suyos; OWNER/ADMIN ven todos y pueden filtrar por chofer.
const buildWhere = (actor, filters, today) => {
  const and = [];
  if (!isPrivileged(actor)) and.push({ driverId: actor.id });
  else if (filters.driverId) and.push({ driverId: filters.driverId });

  if (filters.estado) and.push(estadoWhere(filters.estado, today));
  if (filters.targa) {
    and.push({ targa: { contains: filters.targa.replace(/\s+/g, "").toUpperCase() } });
  }
  if (filters.from) and.push({ fecha: { gte: dayToDate(filters.from) } });
  if (filters.to) and.push({ fecha: { lte: dayToDate(filters.to) } });
  if (filters.fueraDePlazo === "true") and.push({ fueraDePlazo: true });
  if (filters.q) {
    const q = filters.q;
    and.push({
      OR: [
        { numero: { contains: q, mode: "insensitive" } },
        { targa: { contains: q.replace(/\s+/g, ""), mode: "insensitive" } },
        { comentarios: { contains: q, mode: "insensitive" } },
        { driver: { is: { nombre: { contains: q, mode: "insensitive" } } } },
        { driver: { is: { apellido: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
};

const assertAccess = (actor, mancato) => {
  if (isPrivileged(actor) || mancato.driverId === actor.id) return;
  throw new AppError("No tienes permisos para realizar esta accion", 403);
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

const buildKey = (id, kind, ext) => `mancato/${id}/${kind}-${Date.now()}-${randomUUID()}.${ext}`;

const uploadAttachment = async (id, kind, file) => {
  const { buffer, mimeType, ext } = await processFile(file);
  const key = buildKey(id, kind, ext);
  await uploadObject(key, buffer, mimeType);
  return key;
};

const person = (p) => (p ? { id: p.id, nombre: p.nombre, apellido: p.apellido } : null);

const attachment = async (key) =>
  key ? { url: await getSignedUrlForKey(key), esPdf: key.endsWith(".pdf") } : null;

// El bucket es privado: la respuesta lleva URLs firmadas frescas, nunca la key interna.
const toResponse = async (m, today) => {
  const vencimientoDay = dateOnlyToDay(m.fechaVencimiento);
  const [foto, comprobante] = await Promise.all([attachment(m.fotoKey), attachment(m.comprobanteKey)]);
  const diasRestantes = dayDiff(today, vencimientoDay);
  return {
    id: m.id,
    numero: m.numero,
    targa: m.targa,
    vehicleId: m.vehicleId,
    driver: person(m.driver),
    registradoPor: person(m.createdBy),
    fecha: m.fecha,
    fechaVencimiento: m.fechaVencimiento,
    costo: Number(m.costo),
    sitioWeb: m.sitioWeb,
    foto,
    comprobante,
    comentarios: m.comentarios,
    estado: deriveEstado(m, today),
    pagado: m.pagado,
    pagadoAt: m.pagadoAt,
    // Negativo = vencido hace N dias; 0 = vence hoy.
    diasRestantes,
    // Se subio al sistema cuando el plazo ya habia vencido (queda fijo al crear).
    fueraDePlazo: m.fueraDePlazo,
    diasTarde: m.fueraDePlazo ? Math.max(0, dayDiff(vencimientoDay, romeDay(m.createdAt))) : 0,
    pagadoFueraDePlazo: Boolean(m.pagadoAt) && romeDay(m.pagadoAt) > vencimientoDay,
    // Fecha y hora reales de registro: la pone el sistema, no se puede editar.
    registradoAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
};

const resolveDriverId = (actor, requestedDriverId) => {
  if (!isPrivileged(actor)) return actor.id;
  if (!requestedDriverId) throw new AppError("Elige el chofer del mancato pagamento", 400);
  return requestedDriverId;
};

export const createMancatoForActor = async (actor, data, files) => {
  if (!files?.foto?.[0]) {
    throw new AppError("La foto del mancato pagamento es obligatoria", 400);
  }
  const driverId = resolveDriverId(actor, data.driverId);

  if (await findMancatoByNumero(data.numero)) {
    throw new AppError(`Ya existe un mancato pagamento con el numero ${data.numero}`, 409);
  }

  const id = randomUUID();
  const now = new Date();
  const vencimiento = calcVencimiento(data.fecha);
  const comprobanteFile = files.comprobante?.[0];

  const uploaded = [];
  try {
    const fotoKey = await uploadAttachment(id, "foto", files.foto[0]);
    uploaded.push(fotoKey);
    let comprobanteKey = null;
    if (comprobanteFile) {
      comprobanteKey = await uploadAttachment(id, "comprobante", comprobanteFile);
      uploaded.push(comprobanteKey);
    }

    const vehicle = await findVehicleByTarga(data.targa);
    const created = await createMancatoRecord({
      id,
      numero: data.numero,
      targa: data.targa,
      vehicleId: vehicle?.id ?? null,
      driverId,
      createdById: actor.id,
      fecha: dayToDate(data.fecha),
      fechaVencimiento: vencimiento,
      costo: data.costo,
      sitioWeb: data.sitioWeb ?? null,
      comentarios: data.comentarios ?? null,
      fotoKey,
      comprobanteKey,
      // Subir el comprobante de pago al registrar ya lo deja como pagado.
      pagado: Boolean(comprobanteKey),
      pagadoAt: comprobanteKey ? now : null,
      // Se subio cuando el plazo ya habia vencido.
      fueraDePlazo: romeDay(now) > dateOnlyToDay(vencimiento),
    });
    return toResponse(created, romeDay());
  } catch (err) {
    await Promise.all(uploaded.map((key) => deleteObject(key).catch(() => {})));
    throw err;
  }
};

const ORDER_BY_ESTADO = {
  // Lo mas urgente primero: el que vence antes (o lleva mas tiempo vencido).
  PENDIENTE: [{ fechaVencimiento: "asc" }, { createdAt: "asc" }],
  VENCIDO: [{ fechaVencimiento: "asc" }, { createdAt: "asc" }],
  PAGADO: [{ pagadoAt: "desc" }, { createdAt: "desc" }],
};

const ORDER_BY_ORDEN = {
  recientes: [{ fecha: "desc" }, { createdAt: "desc" }],
  antiguos: [{ fecha: "asc" }, { createdAt: "asc" }],
  monto: [{ costo: "desc" }, { createdAt: "desc" }],
};

// Sin "orden" explicito, cada estado tiene su orden natural (ver ORDER_BY_ESTADO).
const orderByFor = (query) =>
  ORDER_BY_ORDEN[query.orden] ??
  ORDER_BY_ESTADO[query.estado] ?? [{ fechaVencimiento: "asc" }, { createdAt: "asc" }];

export const listMancatosForActor = async (actor, query) => {
  const today = romeDay();
  const where = buildWhere(actor, query, today);
  const { page, pageSize } = query;

  const [total, rows] = await Promise.all([
    countMancatos(where),
    findMancatos({
      where,
      orderBy: orderByFor(query),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const items = await Promise.all(rows.map((m) => toResponse(m, today)));
  return { items, total, page, pageSize };
};

// Cantidad y total en plata por estado, respetando los filtros (menos el de estado):
// encabezado de cada acordeon sin traer las filas.
export const getMancatoSummaryForActor = async (actor, query) => {
  const today = romeDay();
  const entries = await Promise.all(
    ["VENCIDO", "PENDIENTE", "PAGADO"].map(async (estado) => {
      const where = buildWhere(actor, { ...query, estado }, today);
      const [count, total] = await Promise.all([countMancatos(where), sumMancatosCosto(where)]);
      return [estado, { count, total }];
    })
  );
  return Object.fromEntries(entries);
};

export const getMancatoForActor = async (actor, id) => {
  const mancato = await findMancatoById(id);
  if (!mancato) throw new AppError("Mancato pagamento no encontrado", 404);
  assertAccess(actor, mancato);
  return toResponse(mancato, romeDay());
};

// El chofer solo puede tocar estos campos y solo mientras no este pagado; OWNER/ADMIN
// pueden todo (incluido marcar pagado/pendiente y cambiar la fecha, que recalcula el
// vencimiento). La fecha de vencimiento y la de registro nunca se reciben: las calcula el sistema.
const CHOFER_EDITABLE = ["targa", "costo", "sitioWeb", "comentarios"];

export const updateMancatoForActor = async (actor, id, data, files) => {
  const current = await findMancatoById(id);
  if (!current) throw new AppError("Mancato pagamento no encontrado", 404);
  assertAccess(actor, current);

  const privileged = isPrivileged(actor);
  if (!privileged && current.pagado) {
    throw new AppError("Este mancato pagamento ya esta pagado y no se puede modificar", 403);
  }

  const changes = privileged
    ? { ...data }
    : Object.fromEntries(Object.entries(data).filter(([key]) => CHOFER_EDITABLE.includes(key)));

  if (changes.numero && changes.numero !== current.numero && (await findMancatoByNumero(changes.numero))) {
    throw new AppError(`Ya existe un mancato pagamento con el numero ${changes.numero}`, 409);
  }

  const payload = {};
  for (const key of ["numero", "targa", "costo", "sitioWeb", "comentarios"]) {
    if (changes[key] !== undefined) payload[key] = changes[key];
  }
  if (changes.targa) {
    payload.vehicleId = (await findVehicleByTarga(changes.targa))?.id ?? null;
  }
  if (privileged && changes.driverId) payload.driverId = changes.driverId;
  if (privileged && changes.fecha) {
    const vencimiento = calcVencimiento(changes.fecha);
    payload.fecha = dayToDate(changes.fecha);
    payload.fechaVencimiento = vencimiento;
    payload.fueraDePlazo = romeDay(current.createdAt) > dateOnlyToDay(vencimiento);
  }

  const oldKeys = [];
  const uploaded = [];
  try {
    if (files?.foto?.[0]) {
      payload.fotoKey = await uploadAttachment(id, "foto", files.foto[0]);
      uploaded.push(payload.fotoKey);
      if (current.fotoKey) oldKeys.push(current.fotoKey);
    }
    if (files?.comprobante?.[0]) {
      payload.comprobanteKey = await uploadAttachment(id, "comprobante", files.comprobante[0]);
      uploaded.push(payload.comprobanteKey);
      if (current.comprobanteKey) oldKeys.push(current.comprobanteKey);
      // Subir el comprobante de pago lo deja pagado.
      if (!current.pagado) {
        payload.pagado = true;
        payload.pagadoAt = new Date();
      }
    }
    if (privileged && changes.pagado !== undefined && payload.pagado === undefined) {
      payload.pagado = changes.pagado;
      payload.pagadoAt = changes.pagado ? (current.pagadoAt ?? new Date()) : null;
    }

    if (Object.keys(payload).length === 0) {
      return toResponse(current, romeDay());
    }

    const updated = await updateMancatoById(id, payload);
    await Promise.all(oldKeys.map((key) => deleteObject(key).catch(() => {})));
    return toResponse(updated, romeDay());
  } catch (err) {
    await Promise.all(uploaded.map((key) => deleteObject(key).catch(() => {})));
    throw err;
  }
};

export const deleteMancatoForActor = async (actor, id) => {
  if (!isPrivileged(actor)) {
    throw new AppError("No tienes permisos para realizar esta accion", 403);
  }
  const mancato = await findMancatoById(id);
  if (!mancato) throw new AppError("Mancato pagamento no encontrado", 404);

  await Promise.all(
    [mancato.fotoKey, mancato.comprobanteKey].filter(Boolean).map((key) => deleteObject(key))
  );
  await deleteMancatoById(id);
};

const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const SERIES_MONTHS = 6;
const MAX_TOP_CHOFERES = 4;
const POR_VENCER_DIAS = 3;
const VENCIDO_GRAVE_DIAS = 30;

const pctChange = (current, previous) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

// Ultimo dia (YYYY-MM-DD) de un mes dado como { year, month0 }.
const lastDayOfMonth = (year, month0) =>
  new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);

// Estadisticas para el encabezado de Mancato Pagamento: deuda abierta (sin pagar) hoy y
// al cierre de cada mes, para ver la evolucion y comparar contra el mes anterior.
// "Abierto el dia D" = ya estaba registrado ese dia y todavia no estaba pagado.
export const getMancatoStatsForActor = async (actor, query) => {
  const today = romeDay();
  const where = buildWhere(actor, query, today);
  const [rows, totalChoferes] = await Promise.all([
    findMancatosForStats(where),
    isPrivileged(actor) ? countActiveChoferes() : Promise.resolve(null),
  ]);

  const items = rows.map((r) => ({
    costo: Number(r.costo),
    fechaDay: dateOnlyToDay(r.fecha),
    vencimientoDay: dateOnlyToDay(r.fechaVencimiento),
    createdDay: romeDay(r.createdAt),
    pagado: r.pagado,
    pagadoDay: r.pagadoAt ? romeDay(r.pagadoAt) : null,
    driverId: r.driverId,
    driverName: r.driver ? `${r.driver.nombre} ${r.driver.apellido}` : "Sin chofer",
  }));

  const openAt = (day) =>
    items.filter((i) => i.createdDay <= day && (!i.pagado || (i.pagadoDay && i.pagadoDay > day)));
  const totalOf = (list) => Math.round(list.reduce((sum, i) => sum + i.costo, 0) * 100) / 100;
  const avgAge = (list, day) =>
    list.length === 0
      ? 0
      : Math.round((list.reduce((sum, i) => sum + Math.max(0, dayDiff(i.fechaDay, day)), 0) / list.length) * 10) / 10;

  const [year, month] = today.split("-").map(Number);
  const month0 = month - 1;

  // Cierre de cada uno de los ultimos meses (el actual llega hasta hoy).
  const serie = [];
  for (let back = SERIES_MONTHS - 1; back >= 0; back -= 1) {
    const ref = new Date(Date.UTC(year, month0 - back, 1));
    const day = back === 0 ? today : lastDayOfMonth(ref.getUTCFullYear(), ref.getUTCMonth());
    serie.push({ label: MONTH_LABELS[ref.getUTCMonth()], value: totalOf(openAt(day)) });
  }

  const open = openAt(today);
  const prevMonthEnd = lastDayOfMonth(year, month0 - 1);
  const openPrev = openAt(prevMonthEnd);

  // Deuda por chofer (mayores primero), el resto agrupado en "Otros".
  const byDriver = new Map();
  for (const i of open) {
    const key = i.driverId ?? "none";
    const entry = byDriver.get(key) ?? { driverId: i.driverId, nombre: i.driverName, count: 0, total: 0 };
    entry.count += 1;
    entry.total += i.costo;
    byDriver.set(key, entry);
  }
  const ranked = [...byDriver.values()]
    .map((e) => ({ ...e, total: Math.round(e.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
  const porChofer = ranked.slice(0, MAX_TOP_CHOFERES);
  const rest = ranked.slice(MAX_TOP_CHOFERES);
  if (rest.length > 0) {
    porChofer.push({
      driverId: null,
      nombre: "Otros",
      count: rest.reduce((sum, e) => sum + e.count, 0),
      total: Math.round(rest.reduce((sum, e) => sum + e.total, 0) * 100) / 100,
    });
  }

  const vencidos = open.filter((i) => i.vencimientoDay < today);
  const porVencer = open.filter((i) => {
    const dias = dayDiff(today, i.vencimientoDay);
    return dias >= 0 && dias <= POR_VENCER_DIAS;
  });
  const vencidosGraves = vencidos.filter((i) => dayDiff(i.vencimientoDay, today) > VENCIDO_GRAVE_DIAS);
  const totalPorPagar = totalOf(open);

  return {
    totalPorPagar,
    totalPorPagarDeltaPct: pctChange(totalPorPagar, totalOf(openPrev)),
    avisosAbiertos: open.length,
    avisosTotales: items.length,
    choferesConDeuda: new Set(open.map((i) => i.driverId).filter(Boolean)).size,
    totalChoferes,
    antiguedadMediaDias: avgAge(open, today),
    antiguedadMediaDeltaPct: pctChange(avgAge(open, today), avgAge(openPrev, prevMonthEnd)),
    porChofer,
    serie,
    serieDeltaPct: pctChange(serie.at(-1).value, serie.at(-2)?.value ?? 0),
    recomendacion: {
      vencidos: vencidos.length,
      vencidosMasDe30Dias: vencidosGraves.length,
      porVencer3Dias: porVencer.length,
      totalVencido: totalOf(vencidos),
    },
  };
};
