import { randomUUID } from "node:crypto";
import {
  createLocationPing,
  createUser as createUserRecord,
  deleteLocationPingsOlderThan,
  deleteUserById,
  findAllUsers,
  findLastLocationPing,
  findLocationPingsByDriverAndRange,
  findUserById,
  findUserLocationById,
  findUsersWithFreshLocation,
  updateUserById,
  updateUserLocation,
  updateUserLocationPermission,
  updateUserReperibilidad,
} from "../models/user.model.js";
import { deletePushToken, upsertPushToken } from "../models/pushToken.model.js";
import { env } from "../config/env.js";
import { getFreshVehiclePositionByTarga } from "./velocityFleet.service.js";
import { findActiveRecordsByDriverIds } from "../models/record.model.js";
import { DEPOT_ORIGIN } from "../constants/depot.js";
import { calculateRoute, snapPointsToRoad } from "./routing.service.js";
import { purgeDocumentsForUser } from "./document.service.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressAvatar } from "../utils/imageProcessor.js";
import { AppError } from "../utils/AppError.js";
import { RESPONSABLE_PRESETS } from "../constants/areas.js";
import { hashPassword } from "../utils/password.js";

// Solo un Admin (OWNER) puede crear o ascender a otro usuario a Admin o Responsable; evita que un
// Responsable se autoascienda o cree otros con mas acceso.
const assertCanAssignCargo = (actor, cargo) => {
  if ((cargo === "OWNER" || cargo === "ADMIN") && actor.cargo !== "OWNER") {
    throw new AppError("Solo un Admin puede asignar los cargos Admin o Responsable", 403);
  }
};

const sameAreas = (a = [], b = []) => a.length === b.length && a.every((key) => b.includes(key));

// Sub-rol y areas de un Responsable: solo un Admin las define (aunque sea sobre si mismo). Para
// cualquier otro cargo no aplican y quedan vacios.
const normalizeResponsableFields = (actor, data, target) => {
  const finalCargo = data.cargo ?? target?.cargo;
  const becomesResponsable = finalCargo === "ADMIN" && target?.cargo !== "ADMIN";

  if (finalCargo !== "ADMIN") {
    // Solo se limpia si dejo de ser Responsable o se esta creando otro cargo.
    if (target?.cargo === "ADMIN" || !target) return { ...data, responsableTipo: null, areasPermitidas: [] };
    return data;
  }

  const touchesTipo = data.responsableTipo !== undefined && data.responsableTipo !== (target?.responsableTipo ?? null);
  const touchesAreas = data.areasPermitidas !== undefined && !sameAreas(data.areasPermitidas, target?.areasPermitidas);
  if ((touchesTipo || touchesAreas) && actor.cargo !== "OWNER") {
    throw new AppError("Solo un Admin puede definir el sub-rol y las areas de un Responsable", 403);
  }

  // Un Responsable nuevo tiene que tener sub-rol; los que ya existian sin sub-rol se dejan como estan.
  const tipo = data.responsableTipo ?? target?.responsableTipo ?? null;
  if (becomesResponsable && !tipo) {
    throw new AppError("Elige el sub-rol del Responsable (Milano Sud o Milano Nord)", 400);
  }
  if (becomesResponsable) {
    // Arranca con las areas tipicas de su sub-rol, salvo que el Admin ya haya marcado otras.
    return { ...data, responsableTipo: tipo, areasPermitidas: data.areasPermitidas ?? RESPONSABLE_PRESETS[tipo] ?? [] };
  }
  return data;
};

// Campos que un CHOFER puede modificar sobre si mismo; cargo/area/estado quedan fuera
// para que no pueda autoasignarse privilegios ni reactivarse si fue desactivado.
const SELF_EDITABLE_FIELDS = [
  "nombre",
  "apellido",
  "numeroCelular",
  "password",
  "compartirUbicacion",
  "direccion",
  "contactoEmergenciaNombre",
  "contactoEmergenciaParentesco",
  "contactoEmergenciaTelefono",
];

// El bucket es privado: nunca se expone la key interna, siempre una URL firmada fresca.
export const toUserResponse = async (user) => {
  const { imagenPerfilKey, ...rest } = user;
  return {
    ...rest,
    imagenUrl: imagenPerfilKey ? await getSignedUrlForKey(imagenPerfilKey) : null,
  };
};

export const listUsers = async () => {
  const users = await findAllUsers();
  return Promise.all(users.map(toUserResponse));
};

export const getUserById = async (id) => {
  const user = await findUserById(id);
  if (!user) {
    throw new AppError("Usuario no encontrado", 404);
  }
  return toUserResponse(user);
};

export const createUser = async (actor, data) => {
  assertCanAssignCargo(actor, data.cargo);
  const normalized = normalizeResponsableFields(actor, data, null);

  const hashedPassword = await hashPassword(data.password);

  const user = await createUserRecord({
    ...normalized,
    estado: data.estado ?? "ACTIVO",
    password: hashedPassword,
  });
  return toUserResponse(user);
};

export const updateUser = async (actor, targetId, data) => {
  const isSelf = actor.id === targetId;
  const isPrivileged = actor.cargo === "OWNER" || actor.cargo === "ADMIN";

  let payload = data;

  const target = await findUserById(targetId);
  if (!target) {
    throw new AppError("Usuario no encontrado", 404);
  }
  // Un Responsable gestiona choferes: no toca a los Admin ni a otros Responsables.
  if (actor.cargo === "ADMIN" && !isSelf && target.cargo !== "CHOFER") {
    throw new AppError("No puedes modificar a un Admin ni a otro Responsable", 403);
  }

  if (isSelf && !isPrivileged) {
    payload = Object.fromEntries(
      Object.entries(data).filter(([key]) => SELF_EDITABLE_FIELDS.includes(key))
    );
  }

  if (payload.cargo && payload.cargo !== target.cargo) {
    assertCanAssignCargo(actor, payload.cargo);
  }
  if (isPrivileged) {
    payload = normalizeResponsableFields(actor, payload, target);
  }

  if (payload.password) {
    payload = { ...payload, password: await hashPassword(payload.password) };
  }

  // OWNER/ADMIN puede marcar/desmarcar la reperibilita de otro chofer directamente
  // desde Resumen > Reperibilita (ademas del propio chofer via PATCH /me/reperibilidad) -
  // en los dos casos hay que refrescar la fecha, si no el criterio de "solo cuenta si
  // se marco hoy" (ver isReperibilidadNoDisponibleHoy en el frontend) nunca la toma.
  if (payload.reperibilidadNoDisponible !== undefined) {
    payload = { ...payload, reperibilidadActualizada: new Date() };
  }

  const updated = await updateUserById(targetId, payload);
  return toUserResponse(updated);
};

export const uploadUserAvatar = async (targetId, file) => {
  const user = await findUserById(targetId);
  if (!user) {
    throw new AppError("Usuario no encontrado", 404);
  }

  const buffer = await compressAvatar(file.buffer);
  const key = `avatars/${targetId}/avatar-${Date.now()}-${randomUUID()}.webp`;
  await uploadObject(key, buffer, "image/webp");

  if (user.imagenPerfilKey) {
    await deleteObject(user.imagenPerfilKey);
  }

  const updated = await updateUserById(targetId, { imagenPerfilKey: key });
  return toUserResponse(updated);
};

export const LOCATION_FRESH_MINUTES = 5;

// El chofer parado (repartiendo, esperando firma, etc.) no dispara el watcher nativo
// por distancia (ver useLocationSharing en el frontend), asi que la app reenvia la
// misma posicion como heartbeat para que el mapa no lo de por "no disponible" a los 5
// min. Si el nuevo punto cae dentro de este radio del ultimo guardado en el
// historial, se considera el mismo lugar: no tiene sentido apilar un punto de ruta
// identico por cada heartbeat.
const STATIONARY_RADIUS_METERS = 20;

const EARTH_RADIUS_METERS = 6371000;

const haversineMeters = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
};

// Un GPS "en frio" (chip recien arrancado, o que salio de mucho tiempo sin senal)
// puede reportar varios fixes seguidos a kilometros de la posicion real hasta
// asentarse - eso se ve en el mapa como saltos imposibles entre puntos lejanos en
// pocos segundos. Se descarta ese fix antes de que contamine la ubicacion en vivo o
// el historial, en vez de intentar corregirlo despues (el ajuste a la calle de
// snapPointsToRoad asume una traza fisicamente plausible; un salto de varios km en
// segundos no es "un desvio", es directamente ruido).
const MAX_ACCURACY_METERS = 100;
const MAX_PLAUSIBLE_SPEED_KMH = 160;
// Piso minimo para el tiempo transcurrido al calcular la velocidad implicada - NO es
// un umbral para saltear el chequeo. Un GPS en frio puede mandar varios fixes a
// kilometros de distancia con centesimas de segundo de diferencia entre si (probado
// contra un caso real: 116 puntos en 12 segundos, saltando varios km cada vez) - si
// ese caso se saltea el chequeo por tener poco tiempo transcurrido, es exactamente el
// caso mas implausible el que queda sin filtrar. Con el piso, un salto grande en poco
// tiempo sigue dando una velocidad absurda y se rechaza igual.
const MIN_ELAPSED_SECONDS_FLOOR = 2;
const MIN_DISTANCE_METERS_FOR_SPEED_CHECK = 200;

const isImplausibleFix = ({ lat, lng, accuracy }, lastKnown) => {
  if (accuracy != null && accuracy > MAX_ACCURACY_METERS) return true;
  if (lastKnown?.ubicacionLat == null || !lastKnown?.ubicacionActualizada) return false;

  const distanceMeters = haversineMeters(
    { lat: lastKnown.ubicacionLat, lng: lastKnown.ubicacionLng },
    { lat, lng }
  );
  if (distanceMeters < MIN_DISTANCE_METERS_FOR_SPEED_CHECK) return false;

  const rawElapsedSeconds = (Date.now() - lastKnown.ubicacionActualizada.getTime()) / 1000;
  const elapsedSeconds = Math.max(rawElapsedSeconds, MIN_ELAPSED_SECONDS_FLOOR);
  const impliedSpeedKmh = distanceMeters / 1000 / (elapsedSeconds / 3600);
  return impliedSpeedKmh > MAX_PLAUSIBLE_SPEED_KMH;
};

// Ademas de pisar la ubicacion "actual" (para el mapa en vivo, siempre se actualiza),
// guarda un ping en el historial - asi se puede reconstruir mas adelante la ruta real
// de un dia puntual - salvo que el chofer siga parado en el mismo lugar que el ultimo
// punto guardado, para no llenar el historial de puntos identicos.
export const updateMyLocation = async (actorId, { lat, lng, accuracy }) => {
  // GPS del celular apagado (ver PHONE_LOCATION_ENABLED): una app vieja puede seguir
  // mandando posiciones - se responde OK sin guardar nada ni hacer ninguna consulta.
  if (!env.PHONE_LOCATION_ENABLED) return;

  const lastKnown = await findUserLocationById(actorId);
  if (isImplausibleFix({ lat, lng, accuracy }, lastKnown)) return;

  const lastPing = await findLastLocationPing(actorId);
  const isStationary = lastPing && haversineMeters(lastPing, { lat, lng }) < STATIONARY_RADIUS_METERS;

  await Promise.all([
    updateUserLocation(actorId, lat, lng),
    isStationary ? Promise.resolve() : createLocationPing(actorId, lat, lng),
  ]);
};

export const updateMyLocationPermission = async (actorId, denegado) => {
  if (!env.PHONE_LOCATION_ENABLED) return;
  return updateUserLocationPermission(actorId, denegado);
};

// El propio chofer se marca "no disponible" para la reperibilita de esta noche (o se
// desmarca) - toUserResponse resuelve la URL firmada del avatar igual que cualquier
// otra respuesta de usuario, aunque aca no cambie.
export const updateMyReperibilidad = async (actorId, noDisponible) => {
  const updated = await updateUserReperibilidad(actorId, noDisponible);
  return toUserResponse(updated);
};

// Notificaciones push (ver pushNotification.service.js) - se registra al iniciar
// sesion en el APK y se da de baja al cerrar sesion (usePushNotifications.js).
export const registerPushToken = (actorId, { token, platform }) =>
  upsertPushToken(actorId, token, platform);

export const unregisterPushToken = (actorId, token) => deletePushToken(actorId, token);

// Ruta real de un chofer en un dia puntual (00:00 a 00:00 del dia siguiente, hora
// local Europe/Rome ya resuelta por el caller via el rango gte/lt). Se ajusta a la
// calle vehicular mas cercana (ver snapPointsToRoad) para que un desvio peatonal -el
// chofer entrando a una casa o a una oficina a entregar- no se vea en el mapa como
// parte del trayecto en vehiculo.
export const getDriverRouteHistory = async (driverId, gte, lt) => {
  const puntos = await findLocationPingsByDriverAndRange(driverId, gte, lt);
  return snapPointsToRoad(puntos);
};

// Medida de optimizacion de costos (storage de Neon): sin esto, el historial de
// LocationPing crece para siempre. Se llama a demanda desde un endpoint autenticado
// (ver cleanupLocationPings en user.controller.js) en vez de un setInterval en el
// proceso, porque Render (plan free) apaga el servidor por inactividad - un cron en
// memoria no es confiable ahi. Se dispara desde afuera (ver README, seccion
// "Monitoreo y costos") con un scheduler externo gratuito, ej. cron-job.org, una vez
// por semana o por mes.
export const cleanupOldLocationPings = async () => {
  const cutoffDate = new Date(Date.now() - env.LOCATION_PING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await deleteLocationPingsOlderThan(cutoffDate);
  return { deletedCount: count, retentionDays: env.LOCATION_PING_RETENTION_DAYS, cutoffDate };
};

// Se exponen todos los choferes con ubicacion reciente, tengan o no un servicio en
// camino ahora mismo: el chofer comparte ubicacion durante todo su horario laboral
// (ver useLocationSharing en el frontend), no solo mientras reparte, asi que tambien
// se lo ve "libre" volviendo de una entrega o esperando el proximo servicio - util
// para mandarle el siguiente pedido al que este mas cerca. Un chofer puede tener MAS
// DE UN servicio "en camino" a la vez (un OWNER/ADMIN puede compactar varias entregas
// en un mismo viaje), asi que se devuelve una entrada por cada servicio activo -no una
// sola por chofer-, todas con la misma posicion GPS. Solo son posiciones: NO calcula
// ninguna ruta/ETA aca (eso saldria caro corriendolo cada 20s para todos los choferes
// aunque nadie los este mirando) - el ETA en vivo de un servicio o el regreso al
// deposito de un chofer libre se piden aparte, a demanda, solo para lo que el OWNER/
// ADMIN tiene abierto en el mapa (ver getLiveEtaForRecord en record.service.js y
// getReturnEtaForDriver mas abajo).
export const listActiveDriverLocations = async () => {
  if (!env.PHONE_LOCATION_ENABLED) return [];

  const since = new Date(Date.now() - LOCATION_FRESH_MINUTES * 60 * 1000);
  const users = await findUsersWithFreshLocation(since);
  if (users.length === 0) return [];

  const activeRecords = await findActiveRecordsByDriverIds(users.map((u) => u.id));
  const recordsByDriverId = activeRecords.reduce((acc, record) => {
    (acc[record.driverId] ??= []).push(record);
    return acc;
  }, {});

  return users.flatMap((u) => {
    const records = recordsByDriverId[u.id];
    const base = {
      id: u.id,
      nombre: u.nombre,
      apellido: u.apellido,
      lat: u.ubicacionLat,
      lng: u.ubicacionLng,
      actualizada: u.ubicacionActualizada,
    };

    if (!records?.length) {
      return [{ ...base, servicio: null }];
    }
    return records.map(({ stops, ...servicio }) => ({ ...base, servicio }));
  });
};

// Ruta en vivo desde la posicion GPS actual del chofer de vuelta al deposito (Via
// Walter Tobagi, 8), a demanda: solo se llama cuando el OWNER/ADMIN abre en el mapa el
// marcador de un chofer libre. Best-effort, igual que calculateRoute: si falla o la
// ubicacion no esta fresca, se devuelve null y el mapa muestra "no disponible".
export const getReturnEtaForDriver = async (driverId) => {
  // La posicion sale del GPS del vehiculo asignado al chofer (Velocity Fleet); la del
  // celular solo se usa si esta habilitada (PHONE_LOCATION_ENABLED) y no hay del vehiculo.
  const driver = await findUserById(driverId);
  let origin = null;

  const vehiclePosition = await getFreshVehiclePositionByTarga(driver?.vehiculoAsignado?.targa);
  if (vehiclePosition) {
    origin = { lat: vehiclePosition.lat, lng: vehiclePosition.lng };
  } else if (env.PHONE_LOCATION_ENABLED) {
    const user = await findUserLocationById(driverId);
    const staleSince = new Date(Date.now() - LOCATION_FRESH_MINUTES * 60 * 1000);
    if (user?.ubicacionLat != null && user.ubicacionLng != null && user.ubicacionActualizada >= staleSince) {
      origin = { lat: user.ubicacionLat, lng: user.ubicacionLng };
    }
  }
  if (!origin) return null;

  const ruta = await calculateRoute([origin, { lat: DEPOT_ORIGIN.lat, lng: DEPOT_ORIGIN.lng }]);
  if (!ruta) return null;

  return { distanciaKm: ruta.distanciaKm, duracionMin: ruta.duracionMin, geometria: ruta.geometria };
};

export const deleteUser = async (actor, targetId) => {
  if (actor.id === targetId) {
    throw new AppError("No puedes eliminar tu propia cuenta", 400);
  }

  const user = await findUserById(targetId);
  if (!user) {
    throw new AppError("Usuario no encontrado", 404);
  }
  if (actor.cargo === "ADMIN" && user.cargo !== "CHOFER") {
    throw new AppError("No puedes eliminar a un Admin ni a otro Responsable", 403);
  }

  // Se borran los objetos de R2 antes de la fila: el ON DELETE CASCADE limpia la tabla
  // documentos automaticamente, pero no sabe nada de R2, y dejaria archivos huerfanos en el bucket.
  await purgeDocumentsForUser(targetId);
  if (user.imagenPerfilKey) {
    await deleteObject(user.imagenPerfilKey);
  }

  await deleteUserById(targetId);
};
