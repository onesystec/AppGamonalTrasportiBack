import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

// Cliente (solo lectura) de la API de OneSystec, la plataforma que guarda el historial de GPS de la
// flota (posiciones cada pocos segundos, con ignicion y movimiento). Autentica con una API key de
// la organizacion en "Authorization: Bearer". La clave sale de ONESYSTEC_API_KEY; nunca se escribe
// ni se loguea. Todo es best-effort: un fallo aca nunca debe romper el envio de horas.
const HOUR_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;
// La API devuelve como mucho 5000 posiciones por llamada: con puntos cada ~4 s en movimiento, tramos
// de 3 h entran de sobra.
const POSITIONS_LIMIT = 5000;
const CHUNK_MS = 3 * HOUR_MS;
const VEHICLES_TTL_MS = HOUR_MS;

export const isOnesystecConfigured = () => Boolean(env.ONESYSTEC_BASE_URL && env.ONESYSTEC_API_KEY);

const normalizePlate = (plate) => plate?.replace(/\s+/g, "").toUpperCase() ?? "";

const request = async (path) => {
  if (!isOnesystecConfigured()) throw new AppError("La conexion con el GPS no esta configurada", 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.ONESYSTEC_BASE_URL.replace(/\/+$/, "")}${path}`, {
      headers: { Authorization: `Bearer ${env.ONESYSTEC_API_KEY}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new AppError(`El GPS respondio con error (${res.status})`, 502);
    return await res.json();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("No se pudo consultar el historial del GPS", 502);
  } finally {
    clearTimeout(timer);
  }
};

let vehiclesCache = null;
let vehiclesCachedAt = 0;

// id de OneSystec de un vehiculo por su patente, o null si esa plataforma no lo tiene.
export const findOnesystecVehicleIdByPlate = async (plate) => {
  if (!vehiclesCache || Date.now() - vehiclesCachedAt > VEHICLES_TTL_MS) {
    vehiclesCache = await request("/vehicles");
    vehiclesCachedAt = Date.now();
  }
  const wanted = normalizePlate(plate);
  return vehiclesCache.find((v) => normalizePlate(v.plate) === wanted)?.id ?? null;
};

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// Posiciones del vehiculo entre dos instantes, en orden cronologico y sin repetidos. Se pide por
// tramos de 3 h para no pasar el limite de filas. Cada punto: { at, lat, lng, speed, ignition, moving }.
export const getVehiclePositions = async (onesystecVehicleId, fromMs, toMs) => {
  const byId = new Map();
  for (let start = fromMs; start < toMs; start += CHUNK_MS) {
    const end = Math.min(start + CHUNK_MS - 1000, toMs);
    const rows = await request(
      `/vehicles/${encodeURIComponent(onesystecVehicleId)}/positions?from=${iso(start)}&to=${iso(end)}&limit=${POSITIONS_LIMIT}`
    );
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()]
    .map((p) => ({
      at: new Date(p.ts),
      lat: p.lat,
      lng: p.lng,
      speed: p.speed ?? null,
      // Teltonika IO 239 = ignicion, IO 240 = movimiento.
      ignition: p.ioData?.["239"] == null ? null : p.ioData["239"] === 1,
      moving: p.ioData?.["240"] == null ? null : p.ioData["240"] === 1,
    }))
    .sort((a, b) => a.at - b.at);
};
