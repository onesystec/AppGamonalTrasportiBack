import { env } from "../config/env.js";
import {
  countChoferesConPermiso,
  createRespaldoPing,
  findLastRespaldoPing,
  hasActiveService,
} from "../models/gpsRespaldo.model.js";
import { updateUserGpsRespaldo } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { distanceMeters } from "../utils/stopDetection.js";
import { getGpsHealth } from "./gpsHealth.service.js";
import { toUserResponse } from "./user.service.js";

// GPS de respaldo del celular. Solo funciona si se cumplen las tres cosas a la vez: (1) el chofer lo
// autorizo, (2) el GPS del vehiculo esta bloqueado o caido y (3) el chofer tiene un servicio en curso.
// Si falta cualquiera, no se guarda ninguna posicion: el servidor lo comprueba en cada punto, no solo la app.
const MIN_PING_INTERVAL_MS = 15 * 1000;
const MAX_ACCURACY_M = 100;
const MAX_PLAUSIBLE_SPEED_KMH = 160;
const SERVICE_CACHE_MS = 60 * 1000;

const serviceCache = new Map();
const hasServiceCached = async (driverId) => {
  const hit = serviceCache.get(driverId);
  if (hit && Date.now() - hit.at < SERVICE_CACHE_MS) return hit.value;
  const value = await hasActiveService(driverId);
  serviceCache.set(driverId, { value, at: Date.now() });
  return value;
};

export const setMyGpsRespaldo = async (actor, permitido) => {
  if (actor.cargo !== "CHOFER") throw new AppError("Solo los choferes pueden autorizarlo", 403);
  return toUserResponse(await updateUserGpsRespaldo(actor.id, permitido));
};

// Estado para la app del chofer: "activo" = tiene que estar enviando su ubicacion ahora mismo.
export const getMyGpsRespaldo = async (actor) => {
  const permitido = Boolean(actor.gpsRespaldoPermitido) && actor.cargo === "CHOFER";
  const base = { habilitado: env.GPS_RESPALDO_ENABLED, permitido, activo: false, motivo: null };
  if (!env.GPS_RESPALDO_ENABLED) return { ...base, motivo: "DESACTIVADO" };
  if (!permitido) return { ...base, motivo: "SIN_PERMISO" };

  let health;
  try {
    health = await getGpsHealth();
  } catch {
    return { ...base, motivo: "SIN_ESTADO" };
  }
  if (!health.respaldoActivo) return { ...base, motivo: "GPS_VEHICULO_OK" };
  if (!(await hasServiceCached(actor.id))) return { ...base, motivo: "SIN_SERVICIO" };
  return { ...base, activo: true, desde: health.desde };
};

export const recordMyBackupLocation = async (actor, { lat, lng, accuracy }) => {
  const estado = await getMyGpsRespaldo(actor);
  if (!estado.activo) return { guardado: false, activo: false, motivo: estado.motivo };
  if (accuracy != null && accuracy > MAX_ACCURACY_M) return { guardado: false, activo: true, motivo: "POCA_PRECISION" };

  const last = await findLastRespaldoPing(actor.id);
  if (last) {
    const elapsedMs = Date.now() - last.recordedAt.getTime();
    if (elapsedMs < MIN_PING_INTERVAL_MS) return { guardado: false, activo: true, motivo: "MUY_SEGUIDO" };
    // Un salto imposible (un GPS recien arrancado reporta puntos a kilometros) es ruido, no un recorrido.
    const meters = distanceMeters(last, { lat, lng });
    if (meters > 200 && meters / 1000 / (Math.max(elapsedMs, 2000) / 3600000) > MAX_PLAUSIBLE_SPEED_KMH) {
      return { guardado: false, activo: true, motivo: "SALTO" };
    }
  }
  await createRespaldoPing(actor.id, lat, lng);
  return { guardado: true, activo: true };
};

// Estado para la oficina: salud del GPS de la flota + cuantos choferes autorizaron el respaldo.
export const getGpsStatusForOffice = async ({ verificar = false } = {}) => {
  const [health, counts] = await Promise.all([getGpsHealth({ force: verificar }), countChoferesConPermiso()]);
  return {
    ...health,
    respaldo: { habilitado: env.GPS_RESPALDO_ENABLED, choferesConPermiso: counts.conPermiso, choferesTotal: counts.total },
  };
};
