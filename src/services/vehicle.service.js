import { randomUUID } from "node:crypto";
import {
  createVehicle as createVehicleRecord,
  deleteVehicleById,
  findVehicleById,
  findVehicleIdsAndTargas,
  findVehiclesWithDrivers,
  updateVehicleById,
} from "../models/vehicle.model.js";
import { findOwnerAndAdminUserIds } from "../models/user.model.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import {
  createMantenimiento,
  deleteMantenimientoById,
  findMantenimientoById,
  findMantenimientosByVehicleId,
} from "../models/mantenimiento.model.js";
import {
  createAreaCEntry,
  deleteAreaCEntriesByIds,
  deleteAreaCEntryById,
  findAllEntries,
  findDiscardedEntriesOlderThan,
  findEntryById,
  findTodayEntryForVehicle,
  findUnpaidEntries,
  findUnpaidEntriesOlderThan,
  updateEntryById,
} from "../models/areaCEntry.model.js";
import {
  createSpeedingEvent,
  deleteSpeedingEventsOlderThan,
  findRecentEventForVehicle,
  findRecentEvents,
} from "../models/speedingEvent.model.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { geocodeAddress } from "./geocoding.service.js";
import { calculateRoute } from "./routing.service.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { getVehicleLivePositions } from "./velocityFleet.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { pointInPolygon } from "../utils/pointInPolygon.js";
import { AppError } from "../utils/AppError.js";

const FILE_FIELDS = ["imagen", "libreto", "assicurazione"];

// Mismo poligono que dibuja el Mapa en el front (src/lib/geo/milanoZones.json,
// copiado aca) - fs.readFileSync en vez de "import ... with { type: 'json' }" porque
// ese import necesita Node 20.10+ y package.json declara engines >=18.
const MILANO_ZONES = JSON.parse(
  readFileSync(fileURLToPath(new URL("../constants/milanoZones.json", import.meta.url)), "utf-8")
);
const AREA_C_PATH = MILANO_ZONES.areaC;

// imagen se comprime con Sharp igual que en documentos; libreto/assicurazione ya vienen
// validados como PDF por vehicleUpload.js y se suben tal cual.
const uploadVehicleFile = async (file, field, vehicleId) => {
  if (!file) return null;

  const { buffer, contentType, ext } =
    field === "imagen"
      ? { buffer: await compressImage(file.buffer), contentType: "image/webp", ext: "webp" }
      : { buffer: file.buffer, contentType: "application/pdf", ext: "pdf" };

  const key = `vehiculos/${vehicleId}/${field}-${Date.now()}-${randomUUID()}.${ext}`;
  await uploadObject(key, buffer, contentType);
  return key;
};

// El bucket es privado: la respuesta siempre lleva URLs firmadas frescas, nunca las keys internas.
const toResponse = async (vehicle) => ({
  id: vehicle.id,
  targa: vehicle.targa,
  modelo: vehicle.modelo,
  imagenUrl: vehicle.imagenKey ? await getSignedUrlForKey(vehicle.imagenKey) : null,
  libretoUrl: vehicle.libretoKey ? await getSignedUrlForKey(vehicle.libretoKey) : null,
  assicurazioneUrl: vehicle.assicurazioneKey ? await getSignedUrlForKey(vehicle.assicurazioneKey) : null,
  area: vehicle.area,
  grupo: vehicle.grupo,
  estado: vehicle.estado,
  poliza: vehicle.poliza,
  rTecnica: vehicle.rTecnica,
  kmUltimoMantenimiento: vehicle.kmUltimoMantenimiento,
  kmActual: vehicle.kmActual,
  autorizadoAreaC: vehicle.autorizadoAreaC,
  createdAt: vehicle.createdAt,
  updatedAt: vehicle.updatedAt,
  // Solo viene cuando la consulta incluyo los choferes (lista de vehiculos).
  ...(vehicle.choferesAsignados && {
    conductores: vehicle.choferesAsignados.map((c) => ({
      id: c.id,
      nombre: `${c.nombre} ${c.apellido}`.trim(),
    })),
  }),
});

export const createVehicleRecordForActor = async (data, files) => {
  const id = randomUUID();

  const [imagenKey, libretoKey, assicurazioneKey] = await Promise.all(
    FILE_FIELDS.map((field) => uploadVehicleFile(files?.[field]?.[0], field, id))
  );

  const vehicle = await createVehicleRecord({
    id,
    targa: data.targa,
    modelo: data.modelo,
    area: data.area,
    grupo: data.grupo,
    estado: data.estado ?? "DISPONIBLE",
    poliza: data.poliza,
    rTecnica: data.rTecnica,
    kmUltimoMantenimiento: data.kmUltimoMantenimiento,
    kmActual: data.kmActual,
    autorizadoAreaC: data.autorizadoAreaC ?? false,
    imagenKey,
    libretoKey,
    assicurazioneKey,
  });

  invalidateVehiclesCache();
  return toResponse(vehicle);
};

export const listVehiclesForActor = async () => {
  const vehicles = await findVehiclesWithDrivers();
  return Promise.all(vehicles.map(toResponse));
};

export const getVehicleByIdForActor = async (id) => {
  const vehicle = await findVehicleById(id);
  if (!vehicle) {
    throw new AppError("Vehiculo no encontrado", 404);
  }
  return toResponse(vehicle);
};

export const updateVehicleForActor = async (id, data, files) => {
  const vehicle = await findVehicleById(id);
  if (!vehicle) {
    throw new AppError("Vehiculo no encontrado", 404);
  }

  const payload = { ...data };

  for (const field of FILE_FIELDS) {
    const file = files?.[field]?.[0];
    if (!file) continue;

    const keyField = `${field}Key`;
    const newKey = await uploadVehicleFile(file, field, id);

    if (vehicle[keyField]) {
      await deleteObject(vehicle[keyField]);
    }

    payload[keyField] = newKey;
  }

  const updated = await updateVehicleById(id, payload);
  invalidateVehiclesCache();
  return toResponse(updated);
};

// El chequeo de Mecanica es un endpoint aparte del PATCH generico: cada guardado
// deja constancia en el historial ademas de actualizar los valores "actuales" del
// vehiculo, para no perder el rastro de lecturas anteriores.
export const registerKmForActor = async (id, data, actorId) => {
  const vehicle = await findVehicleById(id);
  if (!vehicle) {
    throw new AppError("Vehiculo no encontrado", 404);
  }

  const kmUltimoMantenimiento = data.kmUltimoMantenimiento ?? vehicle.kmUltimoMantenimiento;
  const kmActual = data.kmActual ?? vehicle.kmActual;

  if (kmUltimoMantenimiento == null || kmActual == null) {
    throw new AppError("Cargar KM Ultimo Mantenimiento y KM Actual", 400);
  }

  const [updated] = await Promise.all([
    updateVehicleById(id, { kmUltimoMantenimiento, kmActual }),
    createMantenimiento({ vehiculoId: id, kmUltimoMantenimiento, kmActual, usuarioId: actorId }),
  ]);

  return toResponse(updated);
};

const toMantenimientoResponse = (registro) => ({
  id: registro.id,
  kmUltimoMantenimiento: registro.kmUltimoMantenimiento,
  kmActual: registro.kmActual,
  usuario: registro.usuario ? `${registro.usuario.nombre} ${registro.usuario.apellido}` : null,
  createdAt: registro.createdAt,
});

export const listMantenimientosForActor = async (id) => {
  const registros = await findMantenimientosByVehicleId(id);
  return registros.map(toMantenimientoResponse);
};

export const deleteMantenimientoForActor = async (vehiculoId, mantenimientoId) => {
  const registro = await findMantenimientoById(mantenimientoId);
  if (!registro || registro.vehiculoId !== vehiculoId) {
    throw new AppError("Registro de mantenimiento no encontrado", 404);
  }

  await deleteMantenimientoById(mantenimientoId);
};

const normalizeTarga = (targa) => targa?.replace(/\s+/g, "").toUpperCase() ?? "";

// Cache en memoria del mapeo targa -> vehiculo (id/targa nomas, ver
// findVehicleIdsAndTargas): la flota casi no cambia en el dia a dia (dar de alta/baja
// un vehiculo es una accion manual, rara), asi que no hace falta pedirle esto a Neon en
// cada poll del Mapa (cada 30s, ver REFRESH_INTERVAL_MS en el front) - alcanza con
// refrescarlo cada 5 min. Medida de optimizacion de costos: sin esto, apenas Velocity
// Fleet tenga datos, cada pestania del Mapa abierta le pega una consulta completa a la
// tabla de vehiculos a Neon cada 30s, para siempre.
const VEHICLES_CACHE_MS = 5 * 60 * 1000;
let cachedVehicles = null;
let cachedVehiclesAt = 0;

const getVehiclesForPositionLookup = async () => {
  if (cachedVehicles && Date.now() - cachedVehiclesAt < VEHICLES_CACHE_MS) return cachedVehicles;
  cachedVehicles = await findVehicleIdsAndTargas();
  cachedVehiclesAt = Date.now();
  return cachedVehicles;
};

// Se llama al crear/editar/borrar un vehiculo (targa incluida) para que ese cambio se
// vea de inmediato en el cruce con Velocity Fleet, en vez de esperar hasta 5 min a que
// venza el cache solo.
const invalidateVehiclesCache = () => {
  cachedVehicles = null;
};

// El Area C de Milano solo cobra Lunes a Viernes de 7:30 a 19:30 (hora local
// Europe/Rome) - fuera de esa ventana (noche, fin de semana) circular ahi adentro no
// cuesta nada, asi que no tiene sentido generar una alerta de "hay que pagar".
// Limitacion conocida: no contempla feriados ni las suspensiones puntuales que
// publica el Comune di Milano (ej. agosto algunos anios) - esos casos raros los tiene
// que descartar a mano quien revise la seccion Area C del Mapa.
const AREA_C_START_MINUTES = 7 * 60 + 30; // 07:30
const AREA_C_END_MINUTES = 19 * 60 + 30; // 19:30

const isAreaCActiveNow = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;

  const minutesSinceMidnight = Number(parts.hour) * 60 + Number(parts.minute);
  return minutesSinceMidnight >= AREA_C_START_MINUTES && minutesSinceMidnight < AREA_C_END_MINUTES;
};

// Registra una entrada al Area C (ver AreaCEntry en el schema) para cada vehiculo SIN
// autorizadoAreaC cuya posicion actual cae dentro del poligono, solo mientras el Area C
// esta activa (ver isAreaCActiveNow) - nunca un punto GPS suelto, solo el evento de
// entrada, y como mucho uno por vehiculo por dia (el Area C de Milano se paga por dia
// completo, ver findTodayEntryForVehicle). Best-effort y no bloqueante: un error aca (o
// que Neon este momentaneamente lento) nunca debe romper la respuesta de posiciones en
// vivo del Mapa.
const checkAreaCEntries = async (matched) => {
  if (!isAreaCActiveNow()) return;

  const insideUnauthorized = matched.filter(
    (m) => !m.autorizadoAreaC && pointInPolygon({ lat: m.lat, lng: m.lng }, AREA_C_PATH)
  );
  if (insideUnauthorized.length === 0) return;

  // Se pide una sola vez por llamada (no por vehiculo) y solo si hace falta - la
  // mayoria de los polls no crean ninguna entrada nueva.
  let recipientIds = null;

  for (const vehicle of insideUnauthorized) {
    try {
      const today = await findTodayEntryForVehicle(vehicle.vehicleId);
      if (today) continue;
      await createAreaCEntry(vehicle.vehicleId, vehicle.targa);

      recipientIds ??= await findOwnerAndAdminUserIds();
      sendPushToUserIds(recipientIds, {
        title: "Area C sin autorizacion",
        body: `El vehiculo ${vehicle.targa} entro al Area C sin autorizacion`,
        data: { type: "area-c", targa: vehicle.targa },
      }).catch((err) => console.error("No se pudo enviar push de Area C:", err.message));
    } catch (err) {
      console.error(`No se pudo registrar la entrada al Area C de ${vehicle.targa}:`, err.message);
    }
  }
};

// Velocity Fleet no siempre reporta en km/h (ver speed_measure_text en la doc) - se
// convierte antes de comparar contra el umbral. Unidad desconocida => null (no se
// evalua ese vehiculo, mejor no arriesgar un falso positivo/negativo por asumir mal).
const MPH_TO_KMH = 1.60934;
const toKmh = (speed, speedUnit) => {
  if (speed == null || !speedUnit) return null;
  const unit = speedUnit.trim().toUpperCase();
  if (unit === "KM/H" || unit === "KMH") return speed;
  if (unit === "MPH") return speed * MPH_TO_KMH;
  return null;
};

// Registra un exceso de velocidad (ver SpeedingEvent en el schema) para cada vehiculo
// que supere SPEEDING_THRESHOLD_KMH - nunca un punto GPS suelto, y como mucho uno cada
// SPEEDING_DEDUP_MINUTES por vehiculo (un exceso sostenido de varios minutos se agrupa
// como el mismo episodio, no una fila nueva en cada poll). Best-effort y no
// bloqueante, mismo criterio que checkAreaCEntries.
const checkSpeedingEvents = async (matched) => {
  const speeding = matched
    .map((m) => ({ ...m, speedKmh: toKmh(m.speed, m.speedUnit) }))
    .filter((m) => m.speedKmh != null && m.speedKmh > env.SPEEDING_THRESHOLD_KMH);
  if (speeding.length === 0) return;

  let recipientIds = null;

  for (const vehicle of speeding) {
    try {
      const recent = await findRecentEventForVehicle(vehicle.vehicleId, env.SPEEDING_DEDUP_MINUTES);
      if (recent) continue;
      await createSpeedingEvent(vehicle.vehicleId, vehicle.targa, vehicle.speedKmh);

      recipientIds ??= await findOwnerAndAdminUserIds();
      sendPushToUserIds(recipientIds, {
        title: "Exceso de velocidad",
        body: `El vehiculo ${vehicle.targa} supero los ${env.SPEEDING_THRESHOLD_KMH}km/h (${Math.round(vehicle.speedKmh)}km/h)`,
        data: { type: "speeding", targa: vehicle.targa },
      }).catch((err) => console.error("No se pudo enviar push de exceso de velocidad:", err.message));
    } catch (err) {
      console.error(`No se pudo registrar el exceso de velocidad de ${vehicle.targa}:`, err.message);
    }
  }
};

// Cruza la posicion en vivo de Velocity Fleet (GPS del vehiculo, ver
// velocityFleet.service.js) con nuestros vehiculos por targa. Best-effort: si
// Velocity Fleet no responde, o esa unidad puntual no tiene el GPS instalado (no
// aparece en la respuesta), simplemente no se le devuelve posicion - el Mapa (front)
// sigue mostrando la ubicacion del celular del chofer para ese vehiculo en ese caso,
// nunca lo deja sin pin.
export const listVehicleLivePositionsForActor = async () => {
  let positions;
  try {
    positions = await getVehicleLivePositions();
  } catch (err) {
    console.error("No se pudo consultar Velocity Fleet:", err.message);
    return [];
  }
  if (positions.length === 0) return [];

  const byTarga = new Map(positions.map((p) => [p.targa, p]));
  const vehicles = await getVehiclesForPositionLookup();

  const matched = vehicles
    .map((v) => {
      const position = byTarga.get(normalizeTarga(v.targa));
      if (!position) return null;
      return {
        vehicleId: v.id,
        targa: v.targa,
        autorizadoAreaC: v.autorizadoAreaC,
        lat: position.lat,
        lng: position.lng,
        speed: position.speed,
        speedUnit: position.speedUnit,
        ignition: position.ignition,
        direction: position.direction,
        updatedAt: position.updatedAt,
      };
    })
    .filter(Boolean);

  // A demanda de esta misma request (no un proceso aparte corriendo solo) - ver el
  // comentario de checkAreaCEntries. Se dispara siempre que se pidan posiciones, sea
  // desde el Mapa o desde la campanita de notificaciones.
  await checkAreaCEntries(matched);
  await checkSpeedingEvents(matched);

  return matched.map(({ autorizadoAreaC, ...position }) => position);
};

// Crea una ficha de Vehiculo (area SIN_ASIGNAR, modelo "Por completar" - para que se
// note de un vistazo que falta revisarla a mano) para cada targa que el GPS de
// Velocity Fleet reporte y que todavia no tenga ficha en la app. Pedido explicito del
// OWNER para tener un registro completo de cada targa "por si acaso". A demanda (boton
// en Vehiculos), nunca automatico en cada poll - a diferencia de Area C/exceso de
// velocidad, esto crea datos de negocio reales (una fila de Vehiculo), no una alerta
// descartable.
//
// Fuente de targas: las posiciones en vivo (unico endpoint de Velocity Fleet
// integrado hoy) - solo capta vehiculos transmitiendo EN ESE MOMENTO. Si alguno esta
// apagado justo ahora, no aparece esta vez, pero se importa solo la proxima vez que
// este encendido y se vuelva a correr esto.
export const syncVehiclesFromVelocityFleetForActor = async () => {
  let positions;
  try {
    positions = await getVehicleLivePositions();
  } catch (err) {
    throw new AppError(`No se pudo consultar Velocity Fleet: ${err.message}`, 502);
  }

  const existingTargas = new Set(
    (await getVehiclesForPositionLookup()).map((v) => normalizeTarga(v.targa))
  );

  const seen = new Set();
  const created = [];
  for (const position of positions) {
    const normTarga = normalizeTarga(position.targa);
    if (!normTarga || existingTargas.has(normTarga) || seen.has(normTarga)) continue;
    seen.add(normTarga);

    const vehicle = await createVehicleRecord({
      id: randomUUID(),
      targa: position.targa,
      modelo: "Por completar",
      area: "SIN_ASIGNAR",
      estado: "DISPONIBLE",
    });
    created.push({ id: vehicle.id, targa: vehicle.targa });
  }

  if (created.length > 0) invalidateVehiclesCache();

  return { createdCount: created.length, created };
};

// El bucket es privado: la respuesta siempre lleva una URL firmada fresca del
// comprobante, nunca la key interna (mismo criterio que toResponse de vehiculos).
const toAreaCEntryResponse = async (entry) => ({
  id: entry.id,
  vehicleId: entry.vehicleId,
  targa: entry.targa,
  enteredAt: entry.enteredAt,
  pagado: entry.pagado,
  paidAt: entry.paidAt,
  comprobanteUrl: entry.comprobanteKey ? await getSignedUrlForKey(entry.comprobanteKey) : null,
});

// Seccion "Area C" del Mapa (pestanias Pagado/No pagado, ver findAllEntries).
export const listAreaCEntriesForActor = async () => {
  const entries = await findAllEntries();
  return Promise.all(entries.map(toAreaCEntryResponse));
};

// Alertas de Area C sin pagar (ver findUnpaidEntries) - para la campanita de
// notificaciones del front. Una vez marcada pagada, deja de aparecer aca (y por lo
// tanto en la campanita) - no hace falta que el usuario la descarte a mano.
export const listUnpaidAreaCEntriesForActor = () => findUnpaidEntries();

// Marca (o desmarca) una entrada de Area C como pagada, con opcionalmente una foto del
// comprobante - ver la seccion "Area C" del Mapa en el front. Reemplaza el comprobante
// anterior si ya habia uno (borra el viejo de R2 antes de subir el nuevo, mismo
// criterio que updateVehicleForActor).
export const updateAreaCEntryForActor = async (id, data, file) => {
  const entry = await findEntryById(id);
  if (!entry) {
    throw new AppError("Entrada de Area C no encontrada", 404);
  }

  const payload = { pagado: data.pagado, paidAt: data.pagado ? new Date() : null };

  if (file) {
    const buffer = await compressImage(file.buffer);
    const key = `area-c/${entry.vehicleId}/${Date.now()}-${randomUUID()}.webp`;
    await uploadObject(key, buffer, "image/webp");
    if (entry.comprobanteKey) await deleteObject(entry.comprobanteKey);
    payload.comprobanteKey = key;
  }

  const updated = await updateEntryById(id, payload);
  return toAreaCEntryResponse(updated);
};

const romeDay = (date) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });

// Elimina una entrada de Area C que no queremos guardar (boton "Eliminar" de Mapa >
// Area C, tras confirmar en el front). Siempre borra el comprobante de R2. Si la entrada
// es de HOY (hora de Roma) no se borra la fila sino que se oculta (descartada): el Area C
// se cobra por dia y checkAreaCEntries crea una entrada nueva si no encuentra ninguna de
// hoy - sin esa marca, el registro reaparecia al siguiente chequeo (y con un push
// nuevo) mientras el vehiculo siguiera dentro. Las de dias anteriores se borran de verdad.
export const deleteAreaCEntryForActor = async (id) => {
  const entry = await findEntryById(id);
  if (!entry || entry.descartada) {
    throw new AppError("Entrada de Area C no encontrada", 404);
  }

  if (entry.comprobanteKey) await deleteObject(entry.comprobanteKey);

  if (romeDay(entry.enteredAt) === romeDay(new Date())) {
    await updateEntryById(id, { descartada: true, comprobanteKey: null, pagado: false, paidAt: null });
  } else {
    await deleteAreaCEntryById(id);
  }

  return { id };
};

// Medida de optimizacion de costos (storage de Neon): sin esto, AreaCEntry crece para
// siempre. Solo poda lo que sigue SIN pagar (ver findUnpaidEntriesOlderThan) - una
// pagada queda de por vida, igual que cualquier otro documento de la app. Si alguna
// (sin pagar) tenia una foto de comprobante subida igual, se borra tambien de R2 antes
// de borrar la fila, para no dejar archivos huerfanos.
export const cleanupOldAreaCEntries = async () => {
  const cutoffDate = new Date(Date.now() - env.AREA_C_ENTRY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // Ademas de lo sin pagar vencido, se limpian las "eliminadas" de hace mas de 1 dia (ya
  // pasaron a otro dia de Roma, la marca no hace falta - ver deleteAreaCEntryForActor).
  const discardedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const toDelete = [
    ...(await findUnpaidEntriesOlderThan(cutoffDate)),
    ...(await findDiscardedEntriesOlderThan(discardedCutoff)),
  ].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
  if (toDelete.length === 0) {
    return { deletedCount: 0, retentionDays: env.AREA_C_ENTRY_RETENTION_DAYS, cutoffDate };
  }

  const keysToDelete = toDelete.map((e) => e.comprobanteKey).filter(Boolean);
  await Promise.all(keysToDelete.map(deleteObject));
  await deleteAreaCEntriesByIds(toDelete.map((e) => e.id));

  return { deletedCount: toDelete.length, retentionDays: env.AREA_C_ENTRY_RETENTION_DAYS, cutoffDate };
};

// Excesos de velocidad recientes (ver checkSpeedingEvents) - para la campanita de
// notificaciones del front. A diferencia de Area C, es un aviso comun (se puede
// descartar con la X normal).
export const listSpeedingEventsForActor = () => findRecentEvents();

// Medida de optimizacion de costos (storage de Neon): sin excepciones (a diferencia de
// AreaCEntry, aca no hay "pagado" que conservar de por vida) - se poda todo lo que
// supere SPEEDING_EVENT_RETENTION_DAYS.
export const cleanupOldSpeedingEvents = async () => {
  const cutoffDate = new Date(Date.now() - env.SPEEDING_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await deleteSpeedingEventsOlderThan(cutoffDate);
  return { deletedCount: count, retentionDays: env.SPEEDING_EVENT_RETENTION_DAYS, cutoffDate };
};

export const deleteVehicleForActor = async (id) => {
  const vehicle = await findVehicleById(id);
  if (!vehicle) {
    throw new AppError("Vehiculo no encontrado", 404);
  }

  const keysToDelete = [vehicle.imagenKey, vehicle.libretoKey, vehicle.assicurazioneKey].filter(Boolean);
  await Promise.all(keysToDelete.map(deleteObject));

  await deleteVehicleById(id);
  invalidateVehiclesCache();
};

// "A donde llegaria y en cuanto tiempo si un vehiculo/chofer saliera ahora desde su
// posicion actual hacia una direccion o ciudad escrita a mano" (Mapa, buscador de
// targa) - reutiliza el geocoder que ya usan los registros (con cache en
// GeocodeCache, sin costo extra a Google en direcciones repetidas) y el mismo
// calculo de ruta que la ETA en vivo de un servicio. origenLat/Lng los manda el
// front (la posicion que ya esta mostrando en el marcador). Best-effort: si la
// direccion no geocodifica o no se puede calcular la ruta, se devuelve null y el
// front muestra "no disponible", no se rompe la busqueda.
export const getEtaToDestinationForActor = async ({ origenLat, origenLng, destino }) => {
  let destinoCoords;
  try {
    destinoCoords = await geocodeAddress(destino);
  } catch {
    return null;
  }

  const ruta = await calculateRoute([{ lat: origenLat, lng: origenLng }, destinoCoords]);
  if (!ruta) return null;

  return {
    distanciaKm: ruta.distanciaKm,
    duracionMin: ruta.duracionMin,
    // OSRM ya devuelve la geometria completa en la misma consulta que calcula
    // distancia/duracion (ver calculateRoute) - no es una llamada extra, es aprovechar
    // lo que ya vino, para poder dibujar la ruta en el mapa.
    geometria: ruta.geometria,
    destino: destinoCoords,
  };
};
