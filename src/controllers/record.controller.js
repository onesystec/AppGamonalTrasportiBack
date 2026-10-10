import {
  ajustarKmViajeForActor,
  compactarForActor,
  descompactarForActor,
  listCompactableForActor,
  reordenarForActor,
} from "../services/compactado.service.js";
import {
  createRecord,
  deleteRecord,
  exportRecordsForActor,
  getLiveEtaForRecord,
  getRecordByIdForActor,
  listPendingRecordsForActor,
  listRecordsForActor,
  listRecordsResumenForActor,
  listRecordsSummaryForActor,
  searchRecordsForActor,
  setFaltantesExcepcionForActor,
  updateDeclaracionesForActor,
  updateRecordForActor,
} from "../services/record.service.js";
import { countUnsupportedForDriver } from "../services/faltantes.service.js";
import { buildDateRange } from "../utils/dateRange.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { cachedResponse } from "../utils/responseCache.js";

const RECORDS_CACHE_TTL_MS = 60 * 1000;

export const create = asyncHandler(async (req, res) => {
  const record = await createRecord(req.body, { actor: req.user });
  res.status(201).json({ success: true, data: { record } });
});

// ?days=N (opcional): acota a los ultimos N dias en vez de traer todo el historico -
// usado por paginas que solo necesitan una ventana reciente (ej. Resumen general/
// semanal). Sin el query param, comportamiento identico a siempre (todo el historial).
export const list = asyncHandler(async (req, res) => {
  const days = Number(req.query.days);
  const dateRange =
    Number.isFinite(days) && days > 0
      ? { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000), lt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
      : undefined;
  // ?vista=resumen: version liviana para el dashboard del Admin (ver listRecordsResumenForActor).
  const resumen = req.query.vista === "resumen";
  const load = () => (resumen ? listRecordsResumenForActor(req.user, dateRange) : listRecordsForActor(req.user, dateRange));

  // Para Admin y Responsables el listado es pesado (miles de servicios) y lo piden varias pantallas: se
  // comparte la consulta y se reutiliza hasta 60 s, o hasta que se guarde algun servicio o combustible.
  // La clave incluye las areas de quien pregunta, porque lo que ve depende de ellas.
  const privileged = req.user.cargo === "OWNER" || req.user.cargo === "ADMIN";
  const records = privileged
    ? await cachedResponse(
        [
          "records",
          resumen ? "resumen" : "completo",
          Number.isFinite(days) ? days : "todo",
          new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" }),
          // Lo que se devuelve depende solo del cargo y de las areas (no de quien pregunta): todos los
          // Admin comparten una consulta y los Responsables con las mismas areas, otra.
          req.user.cargo === "OWNER" ? "todo" : [...(req.user.areasPermitidas ?? [])].sort().join(","),
        ].join("|"),
        RECORDS_CACHE_TTL_MS,
        load
      )
    : await load();
  res.status(200).json({ success: true, data: { records } });
});

// Export CSV de Registros (ver ExportRecordsModal.jsx del front) - todos los filtros
// ya vienen normalizados por exportRecordsQuerySchema (validate middleware). Devuelve
// JSON (mismo shape que el resto de la app); el CSV en si se arma en el frontend.
export const exportRecords = asyncHandler(async (req, res) => {
  const records = await exportRecordsForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { records } });
});

// Panel de "Pendientes" de Registros: acotado a +/-3 dias, no el historico completo.
export const listPending = asyncHandler(async (req, res) => {
  const records = await listPendingRecordsForActor(req.user);
  res.status(200).json({ success: true, data: { records } });
});

// Buscador de Registros (codigo/cliente/chofer/destino), con limite de resultados.
export const search = asyncHandler(async (req, res) => {
  const records = await searchRecordsForActor(req.user, req.query.q);
  res.status(200).json({ success: true, data: { records } });
});

// Ya no se sincroniza con AppSheet, asi que nunca hay fallos. Se deja la ruta (vacia) para que los APK instalados
// que todavia la consultan para la campanita no fallen.
export const listSyncFailures = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { records: [] } });
});

export const listByYear = asyncHandler(async (req, res) => {
  const dateRange = buildDateRange(req.params.year);
  const records = await listRecordsForActor(req.user, dateRange);
  res.status(200).json({ success: true, data: { records } });
});

export const listByMonth = asyncHandler(async (req, res) => {
  const dateRange = buildDateRange(req.params.year, req.params.month);
  const records = await listRecordsForActor(req.user, dateRange);
  res.status(200).json({ success: true, data: { records } });
});

export const listByDay = asyncHandler(async (req, res) => {
  const dateRange = buildDateRange(req.params.year, req.params.month, req.params.day);
  const records = await listRecordsForActor(req.user, dateRange);
  res.status(200).json({ success: true, data: { records } });
});

// Version liviana de listByMonth: solo id/fechaServicio/estado, para armar el
// acordeon de dias sin traer stops/ruta/economico de cada registro del mes.
export const listSummaryByMonth = asyncHandler(async (req, res) => {
  const dateRange = buildDateRange(req.params.year, req.params.month);
  const records = await listRecordsSummaryForActor(req.user, dateRange);
  res.status(200).json({ success: true, data: { records } });
});

export const getById = asyncHandler(async (req, res) => {
  const record = await getRecordByIdForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { record } });
});

export const update = asyncHandler(async (req, res) => {
  const record = await updateRecordForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: { record } });
});

export const updateDeclaraciones = asyncHandler(async (req, res) => {
  const record = await updateDeclaracionesForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: { record } });
});

export const setExcepcion = asyncHandler(async (req, res) => {
  const record = await setFaltantesExcepcionForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: { record } });
});

export const listCompactables = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { servicios: await listCompactableForActor(req.user) } });
});

export const compactar = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { viaje: await compactarForActor(req.user, req.body.recordIds) } });
});

export const reordenarCompactado = asyncHandler(async (req, res) => {
  const viaje = await reordenarForActor(req.user, req.params.compactadoId, req.body.recordIds);
  res.status(200).json({ success: true, data: { viaje } });
});

// Registros sin sustentar del propio chofer (peajes y carburante de sus servicios hechos): para el dashboard.
export const sinSustentar = asyncHandler(async (req, res) => {
  const { registros, servicios } = await countUnsupportedForDriver(req.user.id);
  res.status(200).json({ success: true, data: { registros, servicios } });
});

export const ajustarKmViaje = asyncHandler(async (req, res) => {
  const viaje = await ajustarKmViajeForActor(req.user, req.params.compactadoId, req.body);
  res.status(200).json({ success: true, data: { viaje } });
});

export const descompactar = asyncHandler(async (req, res) => {
  await descompactarForActor(req.user, req.params.compactadoId);
  res.status(204).send();
});

export const remove = asyncHandler(async (req, res) => {
  await deleteRecord(req.user, req.params.id);
  res.status(204).send();
});

// A demanda desde el mapa: solo se pide para el servicio que el OWNER/ADMIN tiene
// abierto/seleccionado en ese momento, no para todos los servicios activos.
export const getLiveEta = asyncHandler(async (req, res) => {
  const eta = await getLiveEtaForRecord(req.user, req.params.id);
  res.status(200).json({ success: true, data: { eta } });
});
