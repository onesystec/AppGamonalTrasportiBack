import { randomUUID } from "node:crypto";
import { buildLocalDateRange } from "../utils/dateRange.js";
import {
  countActiveChoferes,
  countMultas,
  createMulta as createMultaRecord,
  deleteMultaById,
  findMultaById,
  findAssignedDrivers,
  findMultaByNumero,
  findMultas,
  findMultasForStats,
  findOpenMultasDueBefore,
  findServicesByVehicleInRange,
  findVehicleByTarga,
  sumMultasCosto,
  updateMultaById,
} from "../models/multa.model.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { AppError } from "../utils/AppError.js";
import { findOwnerAndAdminUserIds } from "../models/user.model.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Si el verbale no trae vencimiento cargado, se usa recepcion + 60 dias (lo habitual para
// pagar una multa de transito desde que se notifica). El verbale manda: se puede cambiar.
const PLAZO_POR_DEFECTO_DIAS = 60;

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const romeDay = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const dayToDate = (day) => new Date(`${day}T00:00:00.000Z`);
const dayDiff = (fromDay, toDay) => Math.round((dayToDate(toDay) - dayToDate(fromDay)) / DAY_MS);
const addDays = (day, days) => new Date(dayToDate(day).getTime() + days * DAY_MS);
const dateOnlyToDay = (date) => date.toISOString().slice(0, 10);
const addDaysDay = (day, days) => dateOnlyToDay(addDays(day, days));

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

// El chofer solo ve las suyas; OWNER/ADMIN ven todas y pueden filtrar por chofer.
const buildWhere = (actor, filters, today) => {
  const and = [];
  if (!isPrivileged(actor)) and.push({ driverId: actor.id });
  else if (filters.driverId) and.push({ driverId: filters.driverId });

  if (filters.estado) and.push(estadoWhere(filters.estado, today));
  if (filters.targa) {
    and.push({ targa: { contains: filters.targa.replace(/\s+/g, "").toUpperCase() } });
  }
  if (filters.from) and.push({ fechaRecepcion: { gte: dayToDate(filters.from) } });
  if (filters.to) and.push({ fechaRecepcion: { lte: dayToDate(filters.to) } });
  if (filters.quienPaga) and.push({ quienPaga: filters.quienPaga });
  if (filters.descuentoPendiente === "true") and.push({ quienPaga: "A_DESCONTAR", descontado: false });
  if (filters.q) {
    const q = filters.q;
    and.push({
      OR: [
        { numeroVerbale: { contains: q, mode: "insensitive" } },
        { targa: { contains: q.replace(/\s+/g, ""), mode: "insensitive" } },
        { comentarios: { contains: q, mode: "insensitive" } },
        { driver: { is: { nombre: { contains: q, mode: "insensitive" } } } },
        { driver: { is: { apellido: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
};

const assertAccess = (actor, multa) => {
  if (isPrivileged(actor) || multa.driverId === actor.id) return;
  throw new AppError("No tienes permisos para realizar esta accion", 403);
};

const assertPrivileged = (actor) => {
  if (!isPrivileged(actor)) {
    throw new AppError("Solo la oficina puede cargar o modificar multas", 403);
  }
};

// PDFs tal cual; imagenes comprimidas y normalizadas a webp (mismo criterio que el resto).
const processFile = async (file) => {
  if (file.mimetype === "application/pdf") {
    return { buffer: file.buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  const buffer = await compressImage(file.buffer);
  return { buffer, mimeType: "image/webp", ext: "webp" };
};

const uploadAttachment = async (id, kind, file) => {
  const { buffer, mimeType, ext } = await processFile(file);
  const key = `multas/${id}/${kind}-${Date.now()}-${randomUUID()}.${ext}`;
  await uploadObject(key, buffer, mimeType);
  return key;
};

const person = (p) => (p ? { id: p.id, nombre: p.nombre, apellido: p.apellido } : null);

const attachment = async (key) =>
  key ? { url: await getSignedUrlForKey(key), esPdf: key.endsWith(".pdf") } : null;

// El bucket es privado: la respuesta lleva URLs firmadas frescas, nunca la key interna.
const toResponse = async (m, today) => {
  const vencimientoDay = dateOnlyToDay(m.fechaVencimiento);
  const [multa, comprobante, comprobanteChofer] = await Promise.all([
    attachment(m.multaKey),
    attachment(m.comprobanteKey),
    attachment(m.comprobanteChoferKey),
  ]);
  return {
    id: m.id,
    numeroVerbale: m.numeroVerbale,
    targa: m.targa,
    vehicleId: m.vehicleId,
    driver: person(m.driver),
    registradoPor: person(m.createdBy),
    fechaInfraccion: m.fechaInfraccion,
    fechaRecepcion: m.fechaRecepcion,
    fechaVencimiento: m.fechaVencimiento,
    costo: Number(m.costo),
    quienPaga: m.quienPaga,
    descontado: m.descontado,
    descontadoAt: m.descontadoAt,
    comentarios: m.comentarios,
    multa,
    comprobante,
    comprobanteChofer,
    comprobanteChoferAt: m.comprobanteChoferAt,
    // El chofer mando su comprobante y la oficina todavia no lo confirmo.
    comprobantePendiente: Boolean(m.comprobanteChoferAt) && !m.pagado,
    estado: deriveEstado(m, today),
    pagado: m.pagado,
    pagadoAt: m.pagadoAt,
    // Negativo = vencida hace N dias; 0 = vence hoy.
    diasRestantes: dayDiff(today, vencimientoDay),
    pagadoFueraDePlazo: Boolean(m.pagadoAt) && romeDay(m.pagadoAt) > vencimientoDay,
    // Fecha y hora reales de carga en el sistema: la pone el servidor, no se edita.
    registradoAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
};

// "A descontar" solo tiene sentido si la pago la empresa; si la pago el chofer no hay nada
// que descontar.
const descuentoFields = (quienPaga, descontado, current) => {
  if (quienPaga === "CHOFER_PAGO") return { descontado: false, descontadoAt: null };
  if (descontado === undefined) return {};
  return { descontado, descontadoAt: descontado ? (current?.descontadoAt ?? new Date()) : null };
};

// La infraccion no puede ser posterior a cuando se recibio la multa.
const assertInfraccionBeforeRecepcion = (infraccionDay, recepcionDay) => {
  if (infraccionDay && recepcionDay && infraccionDay > recepcionDay) {
    throw new AppError("La fecha de la infraccion no puede ser posterior a la de recepcion", 400, {
      fechaInfraccion: ["No puede ser posterior a la fecha de recepcion"],
    });
  }
};

const resolveVencimiento = (recepcionDay, vencimientoDay) => {
  const vencimiento = vencimientoDay ?? dateOnlyToDay(addDays(recepcionDay, PLAZO_POR_DEFECTO_DIAS));
  if (vencimiento < recepcionDay) {
    throw new AppError("La fecha de vencimiento no puede ser anterior a la de recepcion", 400, {
      fechaVencimiento: ["No puede ser anterior a la fecha de recepcion"],
    });
  }
  return dayToDate(vencimiento);
};

export const createMultaForActor = async (actor, data, files) => {
  assertPrivileged(actor);
  if (!files?.multa?.[0]) {
    throw new AppError("La foto o PDF de la multa es obligatoria", 400);
  }
  if (await findMultaByNumero(data.numeroVerbale)) {
    throw new AppError(`Ya existe una multa con el verbale ${data.numeroVerbale}`, 409);
  }

  assertInfraccionBeforeRecepcion(data.fechaInfraccion, data.fechaRecepcion);

  const id = randomUUID();
  const now = new Date();
  const vencimiento = resolveVencimiento(data.fechaRecepcion, data.fechaVencimiento);
  const comprobanteFile = files.comprobante?.[0];

  const uploaded = [];
  try {
    const multaKey = await uploadAttachment(id, "multa", files.multa[0]);
    uploaded.push(multaKey);
    let comprobanteKey = null;
    if (comprobanteFile) {
      comprobanteKey = await uploadAttachment(id, "comprobante", comprobanteFile);
      uploaded.push(comprobanteKey);
    }

    const vehicle = await findVehicleByTarga(data.targa);
    const created = await createMultaRecord({
      id,
      numeroVerbale: data.numeroVerbale,
      targa: data.targa,
      vehicleId: vehicle?.id ?? null,
      driverId: data.driverId,
      createdById: actor.id,
      fechaInfraccion: data.fechaInfraccion ? dayToDate(data.fechaInfraccion) : null,
      fechaRecepcion: dayToDate(data.fechaRecepcion),
      fechaVencimiento: vencimiento,
      costo: data.costo,
      quienPaga: data.quienPaga,
      comentarios: data.comentarios ?? null,
      multaKey,
      comprobanteKey,
      // Subir el comprobante de pago al cargarla ya la deja como pagada.
      pagado: Boolean(comprobanteKey),
      pagadoAt: comprobanteKey ? now : null,
    });
    return toResponse(created, romeDay());
  } catch (err) {
    await Promise.all(uploaded.map((key) => deleteObject(key).catch(() => {})));
    throw err;
  }
};

// Lo que ve el chofer de sus multas: lo que le afecta, sin notas internas ni quien la cargo. Si la
// paga el, ve el plazo y el estado; si la paga la empresa, solo el importe y si ya se le descuento.
const toChoferResponse = async (m, today) => {
  const [multa, comprobante, comprobanteChofer] = await Promise.all([
    attachment(m.multaKey),
    attachment(m.comprobanteKey),
    attachment(m.comprobanteChoferKey),
  ]);
  const base = {
    id: m.id,
    numeroVerbale: m.numeroVerbale,
    targa: m.targa,
    fechaInfraccion: m.fechaInfraccion,
    fechaRecepcion: m.fechaRecepcion,
    costo: Number(m.costo),
    quienPaga: m.quienPaga,
    multa,
  };
  if (m.quienPaga === "A_DESCONTAR") {
    return { ...base, descontado: m.descontado, descontadoAt: m.descontadoAt };
  }
  const vencimientoDay = dateOnlyToDay(m.fechaVencimiento);
  return {
    ...base,
    fechaVencimiento: m.fechaVencimiento,
    estado: deriveEstado(m, today),
    pagado: m.pagado,
    pagadoAt: m.pagadoAt,
    diasRestantes: dayDiff(today, vencimientoDay),
    comprobante: comprobante ?? comprobanteChofer,
    comprobantePendiente: Boolean(m.comprobanteChoferAt) && !m.pagado,
  };
};

const toActorResponse = (actor, m, today) => (isPrivileged(actor) ? toResponse(m, today) : toChoferResponse(m, today));

const ORDER_BY_ESTADO = {
  // Lo mas urgente primero: la que vence antes (o lleva mas tiempo vencida).
  PENDIENTE: [{ fechaVencimiento: "asc" }, { createdAt: "asc" }],
  VENCIDO: [{ fechaVencimiento: "asc" }, { createdAt: "asc" }],
  PAGADO: [{ pagadoAt: "desc" }, { createdAt: "desc" }],
};

const ORDER_BY_ORDEN = {
  recientes: [{ fechaRecepcion: "desc" }, { createdAt: "desc" }],
  antiguos: [{ fechaRecepcion: "asc" }, { createdAt: "asc" }],
  monto: [{ costo: "desc" }, { createdAt: "desc" }],
};

// Sin "orden" explicito, cada estado tiene su orden natural (ver ORDER_BY_ESTADO).
const orderByFor = (query) =>
  ORDER_BY_ORDEN[query.orden] ??
  ORDER_BY_ESTADO[query.estado] ?? [{ fechaVencimiento: "asc" }, { createdAt: "asc" }];

export const listMultasForActor = async (actor, query) => {
  const today = romeDay();
  const where = buildWhere(actor, query, today);
  const { page, pageSize } = query;

  const [total, rows] = await Promise.all([
    countMultas(where),
    findMultas({ where, orderBy: orderByFor(query), skip: (page - 1) * pageSize, take: pageSize }),
  ]);

  const items = await Promise.all(rows.map((m) => toActorResponse(actor, m, today)));
  return { items, total, page, pageSize };
};

// Cantidad y total en plata por estado, respetando los filtros (menos el de estado):
// encabezado de cada acordeon sin traer las filas.
export const getMultaSummaryForActor = async (actor, query) => {
  const today = romeDay();
  const entries = await Promise.all(
    ["VENCIDO", "PENDIENTE", "PAGADO"].map(async (estado) => {
      const where = buildWhere(actor, { ...query, estado }, today);
      const [count, total] = await Promise.all([countMultas(where), sumMultasCosto(where)]);
      return [estado, { count, total }];
    })
  );
  return Object.fromEntries(entries);
};

export const getMultaForActor = async (actor, id) => {
  const multa = await findMultaById(id);
  if (!multa) throw new AppError("Multa no encontrada", 404);
  assertAccess(actor, multa);
  return toActorResponse(actor, multa, romeDay());
};

export const updateMultaForActor = async (actor, id, data, files) => {
  assertPrivileged(actor);
  const current = await findMultaById(id);
  if (!current) throw new AppError("Multa no encontrada", 404);

  if (data.numeroVerbale && data.numeroVerbale !== current.numeroVerbale && (await findMultaByNumero(data.numeroVerbale))) {
    throw new AppError(`Ya existe una multa con el verbale ${data.numeroVerbale}`, 409);
  }

  const payload = {};
  for (const key of ["numeroVerbale", "targa", "costo", "comentarios", "quienPaga"]) {
    if (data[key] !== undefined) payload[key] = data[key];
  }
  if (data.targa) payload.vehicleId = (await findVehicleByTarga(data.targa))?.id ?? null;
  if (data.driverId) payload.driverId = data.driverId;

  // Fechas: validar infraccion <= recepcion <= vencimiento con los valores finales.
  const recepcionDay = data.fechaRecepcion ?? dateOnlyToDay(current.fechaRecepcion);
  const infraccionDay =
    data.fechaInfraccion !== undefined
      ? data.fechaInfraccion
      : current.fechaInfraccion
        ? dateOnlyToDay(current.fechaInfraccion)
        : null;
  assertInfraccionBeforeRecepcion(infraccionDay, recepcionDay);
  if (data.fechaInfraccion !== undefined) {
    payload.fechaInfraccion = data.fechaInfraccion ? dayToDate(data.fechaInfraccion) : null;
  }
  if (data.fechaRecepcion || data.fechaVencimiento) {
    const vencimientoDay = data.fechaVencimiento ?? dateOnlyToDay(current.fechaVencimiento);
    payload.fechaRecepcion = dayToDate(recepcionDay);
    payload.fechaVencimiento = resolveVencimiento(recepcionDay, vencimientoDay);
  }

  Object.assign(
    payload,
    descuentoFields(payload.quienPaga ?? current.quienPaga, data.descontado, current)
  );

  const oldKeys = [];
  const uploaded = [];
  try {
    if (files?.multa?.[0]) {
      payload.multaKey = await uploadAttachment(id, "multa", files.multa[0]);
      uploaded.push(payload.multaKey);
      if (current.multaKey) oldKeys.push(current.multaKey);
    }
    if (files?.comprobante?.[0]) {
      payload.comprobanteKey = await uploadAttachment(id, "comprobante", files.comprobante[0]);
      uploaded.push(payload.comprobanteKey);
      if (current.comprobanteKey) oldKeys.push(current.comprobanteKey);
      // Subir el comprobante de pago la deja pagada.
      if (!current.pagado) {
        payload.pagado = true;
        payload.pagadoAt = new Date();
      }
    }
    if (data.pagado !== undefined && payload.pagado === undefined) {
      payload.pagado = data.pagado;
      payload.pagadoAt = data.pagado ? (current.pagadoAt ?? new Date()) : null;
    }
    // Confirmar o reabrir resuelve el comprobante que habia mandado el chofer.
    if (payload.pagado !== undefined && current.comprobanteChoferAt) payload.comprobanteChoferAt = null;

    if (Object.keys(payload).length === 0) {
      return toResponse(current, romeDay());
    }

    const updated = await updateMultaById(id, payload);
    await Promise.all(oldKeys.map((key) => deleteObject(key).catch(() => {})));
    return toResponse(updated, romeDay());
  } catch (err) {
    await Promise.all(uploaded.map((key) => deleteObject(key).catch(() => {})));
    throw err;
  }
};

export const deleteMultaForActor = async (actor, id) => {
  assertPrivileged(actor);
  const multa = await findMultaById(id);
  if (!multa) throw new AppError("Multa no encontrada", 404);

  await Promise.all(
    [multa.multaKey, multa.comprobanteKey, multa.comprobanteChoferKey].filter(Boolean).map((key) => deleteObject(key))
  );
  await deleteMultaById(id);
};

const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const SERIES_MONTHS = 6;
const MAX_TOP_CHOFERES = 4;
const MAX_TOP_DESCUENTO = 5;
const POR_VENCER_DIAS = 7;
const VENCIDA_GRAVE_DIAS = 30;

const round2 = (value) => Math.round(value * 100) / 100;
const pctChange = (current, previous) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

// Ultimo dia (YYYY-MM-DD) de un mes dado como (year, month0).
const lastDayOfMonth = (year, month0) =>
  new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);

// Agrupa por chofer: [{ driverId, nombre, count, total }], mayores primero.
const groupByDriver = (list) => {
  const map = new Map();
  for (const i of list) {
    const key = i.driverId ?? "none";
    const entry = map.get(key) ?? { driverId: i.driverId, nombre: i.driverName, count: 0, total: 0 };
    entry.count += 1;
    entry.total += i.costo;
    map.set(key, entry);
  }
  return [...map.values()].map((e) => ({ ...e, total: round2(e.total) })).sort((a, b) => b.total - a.total);
};

// Estadisticas del encabezado de Multas: deuda abierta (sin pagar) hoy y al cierre de cada
// mes, lo que falta descontar a los choferes y los datos para la recomendacion.
// "Abierta el dia D" = ya estaba cargada ese dia y todavia no estaba pagada.
export const getMultaStatsForActor = async (actor, query) => {
  const today = romeDay();
  const where = buildWhere(actor, query, today);
  const [rows, totalChoferes] = await Promise.all([
    findMultasForStats(where),
    isPrivileged(actor) ? countActiveChoferes() : Promise.resolve(null),
  ]);

  const items = rows.map((r) => ({
    costo: Number(r.costo),
    recepcionDay: dateOnlyToDay(r.fechaRecepcion),
    vencimientoDay: dateOnlyToDay(r.fechaVencimiento),
    createdDay: romeDay(r.createdAt),
    pagado: r.pagado,
    pagadoDay: r.pagadoAt ? romeDay(r.pagadoAt) : null,
    quienPaga: r.quienPaga,
    descontado: r.descontado,
    comprobantePendiente: Boolean(r.comprobanteChoferAt) && !r.pagado,
    driverId: r.driverId,
    driverName: r.driver ? `${r.driver.nombre} ${r.driver.apellido}` : "Sin chofer",
  }));

  // Para el chofer, "por pagar" es solo lo que paga el (lo que paga la empresa se le descuenta aparte).
  const payable = isPrivileged(actor) ? items : items.filter((i) => i.quienPaga === "CHOFER_PAGO");
  const openAt = (day) =>
    payable.filter((i) => i.createdDay <= day && (!i.pagado || (i.pagadoDay && i.pagadoDay > day)));
  const totalOf = (list) => round2(list.reduce((sum, i) => sum + i.costo, 0));
  const avgAge = (list, day) =>
    list.length === 0
      ? 0
      : Math.round((list.reduce((sum, i) => sum + Math.max(0, dayDiff(i.recepcionDay, day)), 0) / list.length) * 10) / 10;

  const [year, month] = today.split("-").map(Number);
  const month0 = month - 1;

  const serie = [];
  for (let back = SERIES_MONTHS - 1; back >= 0; back -= 1) {
    const ref = new Date(Date.UTC(year, month0 - back, 1));
    const day = back === 0 ? today : lastDayOfMonth(ref.getUTCFullYear(), ref.getUTCMonth());
    serie.push({ label: MONTH_LABELS[ref.getUTCMonth()], value: totalOf(openAt(day)) });
  }

  const open = openAt(today);
  const prevMonthEnd = lastDayOfMonth(year, month0 - 1);
  const openPrev = openAt(prevMonthEnd);

  const ranked = groupByDriver(open);
  const porChofer = ranked.slice(0, MAX_TOP_CHOFERES);
  const rest = ranked.slice(MAX_TOP_CHOFERES);
  if (rest.length > 0) {
    porChofer.push({
      driverId: null,
      nombre: "Otros",
      count: rest.reduce((sum, e) => sum + e.count, 0),
      total: round2(rest.reduce((sum, e) => sum + e.total, 0)),
    });
  }

  // Lo que la empresa pago (o va a pagar) y todavia no le descontaron al chofer.
  const descuentoPendiente = items.filter((i) => i.quienPaga === "A_DESCONTAR" && !i.descontado);
  const vencidas = open.filter((i) => i.vencimientoDay < today);
  const porVencer = open.filter((i) => {
    const dias = dayDiff(today, i.vencimientoDay);
    return dias >= 0 && dias <= POR_VENCER_DIAS;
  });
  const vencidasGraves = vencidas.filter((i) => dayDiff(i.vencimientoDay, today) > VENCIDA_GRAVE_DIAS);
  const totalPorPagar = totalOf(open);

  return {
    totalPorPagar,
    totalPorPagarDeltaPct: pctChange(totalPorPagar, totalOf(openPrev)),
    multasAbiertas: open.length,
    multasTotales: payable.length,
    totalChoferes,
    aDescontar: { count: descuentoPendiente.length, total: totalOf(descuentoPendiente) },
    porChoferADescontar: groupByDriver(descuentoPendiente).slice(0, MAX_TOP_DESCUENTO),
    antiguedadMediaDias: avgAge(open, today),
    antiguedadMediaDeltaPct: pctChange(avgAge(open, today), avgAge(openPrev, prevMonthEnd)),
    porChofer,
    serie,
    serieDeltaPct: pctChange(serie.at(-1).value, serie.at(-2)?.value ?? 0),
    recomendacion: {
      vencidas: vencidas.length,
      vencidasMasDe30Dias: vencidasGraves.length,
      porVencer7Dias: porVencer.length,
      totalVencido: totalOf(vencidas),
      aDescontarPendiente: descuentoPendiente.length,
      totalADescontar: totalOf(descuentoPendiente),
      comprobantesPorConfirmar: items.filter((i) => i.comprobantePendiente).length,
    },
  };
};

const hhmm = (date) =>
  date.toLocaleTimeString("es-AR", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false });

// Quien llevaba esa unidad el dia de la infraccion, segun Registros: cada chofer que tuvo
// servicios con ese vehiculo ese dia (con cuantos y de que hora a que hora). Si no hubo
// ninguno, devuelve los choferes que tienen la unidad asignada como habitual.
export const suggestDriversForActor = async (actor, { targa, fecha }) => {
  assertPrivileged(actor);
  const vehicle = await findVehicleByTarga(targa);
  if (!vehicle) return { vehiculoEncontrado: false, candidatos: [], asignados: [] };

  const [year, month, day] = fecha.split("-").map(Number);
  const { gte, lt } = buildLocalDateRange(year, month, day, "Europe/Rome");
  const [services, asignados] = await Promise.all([
    findServicesByVehicleInRange(vehicle.id, gte, lt),
    findAssignedDrivers(vehicle.id),
  ]);

  const byDriver = new Map();
  for (const service of services) {
    const entry = byDriver.get(service.driver.id) ?? {
      id: service.driver.id,
      nombre: service.driver.nombre,
      apellido: service.driver.apellido,
      servicios: 0,
      desde: hhmm(service.fechaServicio),
      hasta: hhmm(service.fechaServicio),
    };
    entry.servicios += 1;
    entry.hasta = hhmm(service.fechaServicio);
    byDriver.set(service.driver.id, entry);
  }
  const candidatos = [...byDriver.values()].sort((a, b) => b.servicios - a.servicios);

  return { vehiculoEncontrado: true, candidatos, asignados };
};

const ALERT_DAYS = 7;
const ALERT_ITEMS_PER_GROUP = 5;

// Multas que piden atencion para la campanita: vencidas y por vencer (7 dias) sin pagar, y
// lo pendiente de descontar. El chofer solo recibe aviso de las suyas que tiene que pagar
// el mismo (quienPaga = CHOFER_PAGO): las "a descontar" las paga la empresa.
export const getMultaAlertsForActor = async (actor) => {
  const today = romeDay();
  const privileged = isPrivileged(actor);
  const limit = dayToDate(addDaysDay(today, ALERT_DAYS));
  const todayDate = dayToDate(today);
  const base = privileged
    ? { pagado: false }
    : { pagado: false, driverId: actor.id, quienPaga: "CHOFER_PAGO" };

  const whereVencidas = { ...base, fechaVencimiento: { lt: todayDate } };
  const wherePorVencer = { ...base, fechaVencimiento: { gte: todayDate, lte: limit } };
  const whereDescuento = { quienPaga: "A_DESCONTAR", descontado: false };

  const [vencidasItems, porVencerItems, vencidasCount, porVencerCount, descuentoCount, descuentoTotal] =
    await Promise.all([
      findOpenMultasDueBefore(whereVencidas, ALERT_ITEMS_PER_GROUP),
      findOpenMultasDueBefore(wherePorVencer, ALERT_ITEMS_PER_GROUP),
      countMultas(whereVencidas),
      countMultas(wherePorVencer),
      privileged ? countMultas(whereDescuento) : Promise.resolve(0),
      privileged ? sumMultasCosto(whereDescuento) : Promise.resolve(0),
    ]);

  const toItem = (m) => ({
    id: m.id,
    numeroVerbale: m.numeroVerbale,
    targa: m.targa,
    costo: Number(m.costo),
    chofer: m.driver ? `${m.driver.nombre} ${m.driver.apellido}` : null,
    diasRestantes: dayDiff(today, dateOnlyToDay(m.fechaVencimiento)),
  });

  return {
    vencidas: { count: vencidasCount, items: vencidasItems.map(toItem) },
    porVencer: { count: porVencerCount, items: porVencerItems.map(toItem) },
    aDescontar: { count: descuentoCount, total: round2(descuentoTotal) },
  };
};

// El chofer sube el comprobante de una multa que paga el mismo. No la deja pagada: queda "por
// confirmar" y se avisa a la oficina, que es quien la marca como pagada.
export const uploadMyComprobanteForActor = async (actor, id, file) => {
  const multa = await findMultaById(id);
  if (!multa) throw new AppError("Multa no encontrada", 404);
  if (isPrivileged(actor) || multa.driverId !== actor.id) {
    throw new AppError("No tienes permisos para realizar esta accion", 403);
  }
  if (multa.quienPaga !== "CHOFER_PAGO") {
    throw new AppError("Esta multa la paga la empresa: no hace falta subir comprobante", 400);
  }
  if (multa.pagado) throw new AppError("Esta multa ya figura como pagada", 400);
  if (!file) throw new AppError("Sube la foto o el PDF del comprobante", 400);

  const key = await uploadAttachment(id, "comprobante-chofer", file);
  try {
    const updated = await updateMultaById(id, { comprobanteChoferKey: key, comprobanteChoferAt: new Date() });
    if (multa.comprobanteChoferKey) await deleteObject(multa.comprobanteChoferKey).catch(() => {});
    findOwnerAndAdminUserIds()
      .then((ids) =>
        sendPushToUserIds(ids, {
          title: "Comprobante de multa por confirmar",
          body: `${actor.nombre} ${actor.apellido} subio el comprobante del verbale ${multa.numeroVerbale}.`,
          data: { type: "multa", multaId: id },
        })
      )
      .catch((err) => console.error("No se pudo avisar del comprobante de multa:", err.message));
    return toChoferResponse(updated, romeDay());
  } catch (err) {
    await deleteObject(key).catch(() => {});
    throw err;
  }
};
