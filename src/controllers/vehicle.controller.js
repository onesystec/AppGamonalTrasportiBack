import { getPushDiagnostics } from "../services/pushNotification.service.js";
import { getVelocityFleetUsageStats } from "../services/velocityFleet.service.js";
import {
  cleanupOldAreaCEntries,
  deleteAreaCEntryForActor,
  cleanupOldSpeedingEvents,
  createVehicleRecordForActor,
  deleteMantenimientoForActor,
  deleteVehicleForActor,
  getEtaToDestinationForActor,
  getVehicleByIdForActor,
  listAreaCEntriesForActor,
  listMantenimientosForActor,
  getSpeedingSummaryForActor,
  listSpeedingEventsForActor,
  listUnpaidAreaCEntriesForActor,
  listVehicleLivePositionsForActor,
  listVehiclesForActor,
  registerKmForActor,
  syncVehiclesFromVelocityFleetForActor,
  updateAreaCEntryForActor,
  updateVehicleForActor,
} from "../services/vehicle.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const vehicle = await createVehicleRecordForActor(req.body, req.files);
  res.status(201).json({ success: true, data: { vehicle } });
});

export const list = asyncHandler(async (req, res) => {
  const vehicles = await listVehiclesForActor();
  res.status(200).json({ success: true, data: { vehicles } });
});

export const listLivePositions = asyncHandler(async (req, res) => {
  const positions = await listVehicleLivePositionsForActor();
  res.status(200).json({ success: true, data: { positions } });
});

// Importa a demanda las targas que reporte Velocity Fleet y que todavia no tengan
// ficha en la app (ver syncVehiclesFromVelocityFleetForActor) - boton en Vehiculos.
export const syncVehiclesFromVelocityFleet = asyncHandler(async (req, res) => {
  const result = await syncVehiclesFromVelocityFleetForActor();
  res.status(200).json({ success: true, data: result });
});

// Monitoreo de uso de Velocity Fleet (medida de optimizacion de costos): expone el
// contador en memoria de velocityFleet.service.js para poder notar un pico anormal de
// consultas antes de que impacte en la factura.
export const getVelocityFleetUsage = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: getVelocityFleetUsageStats() });
});

// Diagnostico de notificaciones push (ver pushNotification.service.js) - para
// confirmar si FIREBASE_SERVICE_ACCOUNT_JSON quedo bien configurado en Render sin
// tener que buscar en los logs.
export const getPushStatus = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: getPushDiagnostics() });
});

// ETA a un destino escrito a mano desde la posicion actual de un vehiculo/chofer (ver
// buscador de targa del Mapa en el front).
export const getEtaToDestination = asyncHandler(async (req, res) => {
  const eta = await getEtaToDestinationForActor(req.body);
  res.status(200).json({ success: true, data: { eta } });
});

// Seccion "Area C" del Mapa (pestanias Pagado/No pagado, ver checkAreaCEntries en
// vehicle.service.js - las entradas se registran solas al consultar live-positions).
export const listAreaCEntries = asyncHandler(async (req, res) => {
  const entries = await listAreaCEntriesForActor();
  res.status(200).json({ success: true, data: { entries } });
});

// Alertas de Area C sin pagar - para la campanita de notificaciones del front.
export const listUnpaidAreaCEntries = asyncHandler(async (req, res) => {
  const entries = await listUnpaidAreaCEntriesForActor();
  res.status(200).json({ success: true, data: { entries } });
});

// Marca (o desmarca) una entrada de Area C como pagada, con opcionalmente una foto
// del comprobante (ver areaCEntryUpload.js) - seccion "Area C" del Mapa.
export const updateAreaCEntry = asyncHandler(async (req, res) => {
  const entry = await updateAreaCEntryForActor(req.params.id, req.body, req.file);
  res.status(200).json({ success: true, data: { entry } });
});

// Elimina una entrada de Area C que no queremos guardar (Mapa > Area C, el front pide
// confirmacion antes) - ver deleteAreaCEntryForActor.
export const deleteAreaCEntry = asyncHandler(async (req, res) => {
  const result = await deleteAreaCEntryForActor(req.params.id);
  res.status(200).json({ success: true, data: result });
});

// Medida de optimizacion de costos (ver cleanupOldAreaCEntries en vehicle.service.js) -
// pensado para dispararse desde afuera con un scheduler externo, mismo criterio que
// /users/location-pings/cleanup.
export const cleanupAreaCEntries = asyncHandler(async (req, res) => {
  const result = await cleanupOldAreaCEntries();
  res.status(200).json({ success: true, data: result });
});

// Excesos de velocidad (ver checkSpeedingEvents en vehicle.service.js) - para la
// campanita de notificaciones del front.
export const listSpeedingEvents = asyncHandler(async (req, res) => {
  const events = await listSpeedingEventsForActor(req.query);
  res.status(200).json({ success: true, data: { events } });
});

// Resumen por dia y por vehiculo para los acordeones de Control de Flota.
export const getSpeedingSummary = asyncHandler(async (req, res) => {
  const summary = await getSpeedingSummaryForActor();
  res.status(200).json({ success: true, data: { summary } });
});

// Medida de optimizacion de costos (ver cleanupOldSpeedingEvents en
// vehicle.service.js) - mismo criterio que cleanupAreaCEntries.
export const cleanupSpeedingEvents = asyncHandler(async (req, res) => {
  const result = await cleanupOldSpeedingEvents();
  res.status(200).json({ success: true, data: result });
});

export const getById = asyncHandler(async (req, res) => {
  const vehicle = await getVehicleByIdForActor(req.params.id);
  res.status(200).json({ success: true, data: { vehicle } });
});

export const update = asyncHandler(async (req, res) => {
  const vehicle = await updateVehicleForActor(req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { vehicle } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteVehicleForActor(req.params.id);
  res.status(204).send();
});

export const registerKm = asyncHandler(async (req, res) => {
  const vehicle = await registerKmForActor(req.params.id, req.body, req.user.id);
  res.status(200).json({ success: true, data: { vehicle } });
});

export const listMantenimientos = asyncHandler(async (req, res) => {
  const mantenimientos = await listMantenimientosForActor(req.params.id);
  res.status(200).json({ success: true, data: { mantenimientos } });
});

export const removeMantenimiento = asyncHandler(async (req, res) => {
  await deleteMantenimientoForActor(req.params.id, req.params.mantenimientoId);
  res.status(204).send();
});
