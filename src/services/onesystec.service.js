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

const request = async (path, { timeoutMs = REQUEST_TIMEOUT_MS, root = false } = {}) => {
  if (!isOnesystecConfigured()) throw new AppError("La conexion con el GPS no esta configurada", 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = env.ONESYSTEC_BASE_URL.replace(/\/+$/, "");
    // root: endpoints que solo existen en la API v1, aunque la URL configurada ya termine en /v1 o no.
    const url = root ? `${base.replace(/\/v1$/i, "")}/v1${path}` : `${base}${path}`;
    const res = await fetch(url, {
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

const ensureVehicles = async ({ fresh = false } = {}) => {
  if (fresh || !vehiclesCache || Date.now() - vehiclesCachedAt > VEHICLES_TTL_MS) {
    vehiclesCache = await request("/vehicles");
    vehiclesCachedAt = Date.now();
  }
  return vehiclesCache;
};

// id de OneSystec de un vehiculo por su patente, o null si esa plataforma no lo tiene.
export const findOnesystecVehicleIdByPlate = async (plate) => {
  const wanted = normalizePlate(plate);
  return (await ensureVehicles()).find((v) => normalizePlate(v.plate) === wanted)?.id ?? null;
};

// Todos los dispositivos (vehiculos) de la cuenta de OneSystec, pidiendo la lista de nuevo (para encontrar los recien instalados): [{ id, plate }].
export const listOnesystecVehicles = async () =>
  (await ensureVehicles({ fresh: true }))
    .map((v) => ({ id: v.id, plate: normalizePlate(v.plate) }))
    .filter((v) => v.plate);

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

// Comprobacion barata de que la cuenta del GPS esta viva: pide la lista de vehiculos. Distingue una
// cuenta rechazada o suspendida (401/402/403, o sin vehiculos: por ejemplo por falta de pago) de una
// caida pasajera (error del servidor, sin conexion). Nunca lanza.
const PROBE_TIMEOUT_MS = 10000;
export const probeOnesystec = async () => {
  if (!isOnesystecConfigured()) return { estado: "NO_CONFIGURADO" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.ONESYSTEC_BASE_URL.replace(/\/+$/, "")}/vehicles`, {
      headers: { Authorization: `Bearer ${env.ONESYSTEC_API_KEY}` },
      signal: controller.signal,
    });
    if ([401, 402, 403].includes(res.status)) {
      return { estado: "BLOQUEADO", detalle: `La cuenta del GPS fue rechazada (HTTP ${res.status})` };
    }
    if (!res.ok) return { estado: "CAIDO", detalle: `El GPS respondio con error (HTTP ${res.status})` };
    const vehicles = await res.json();
    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      return { estado: "BLOQUEADO", detalle: "La cuenta del GPS no devuelve ningun vehiculo" };
    }
    vehiclesCache = vehicles;
    vehiclesCachedAt = Date.now();
    return { estado: "OK" };
  } catch {
    return { estado: "CAIDO", detalle: "No se pudo conectar con el GPS" };
  } finally {
    clearTimeout(timer);
  }
};

// Estilo de conduccion de un vehiculo SOLO en un tramo (API v1: /v1/vehicles/{id}/driving-style?from&to), que es
// el horario real de un servicio. Devuelve los datos crudos: km, calidad e incidentes por categoria (frenadas,
// aceleraciones y giros bruscos, exceso de velocidad), que se suman entre servicios para puntuar a cada chofer.
// Las categorias que el dispositivo no puede detectar vienen en null.
const DRIVING_STYLE_TIMEOUT_MS = 20000;
export const getVehicleDrivingStyle = (onesystecVehicleId, fromMs, toMs) =>
  request(
    `/vehicles/${encodeURIComponent(onesystecVehicleId)}/driving-style?from=${iso(fromMs)}&to=${iso(toMs)}`,
    { root: true, timeoutMs: DRIVING_STYLE_TIMEOUT_MS }
  );

// ---- posiciones en vivo para el Mapa -------------------------------------------------------------------------------
// Ultima posicion de los vehiculos que estan en OneSystec (los dispositivos Teltonika) y no en Velocity Fleet: se mira la ultima media hora
// y, si el vehiculo esta quieto (casi no manda puntos), hasta hace hora y media. Resultado en el mismo formato que las posiciones de Velocity
// Fleet, mas fuente "ONESYSTEC". Un cache corto evita repetir la consulta por cada pestana del Mapa abierta.
const LIVE_TTL_MS = 40 * 1000;
const LIVE_CONCURRENCY = 4;
const LIVE_RECENT_MS = 10 * 60 * 1000;
const LIVE_PARKED_MS = 90 * 60 * 1000;
const liveCache = new Map();

const latestOf = (rows) => rows.at(-1) ?? null;

const fetchLatest = async (onesystecVehicleId, plate) => {
  const now = Date.now();
  let rows = await getVehiclePositions(onesystecVehicleId, now - LIVE_RECENT_MS, now);
  if (!rows.length) rows = await getVehiclePositions(onesystecVehicleId, now - LIVE_PARKED_MS, now);
  const last = latestOf(rows);
  if (!last || last.lat == null || last.lng == null) return null;
  return {
    targa: plate,
    lat: last.lat,
    lng: last.lng,
    speed: last.speed ?? null,
    speedUnit: "km/h",
    ignition: last.ignition === true,
    direction: null,
    updatedAt: last.at,
    fuente: "ONESYSTEC",
  };
};

export const getOnesystecLivePositions = async (plates) => {
  if (!isOnesystecConfigured() || !plates?.length) return [];
  const vehicles = await ensureVehicles();
  const idByPlate = new Map(vehicles.map((v) => [normalizePlate(v.plate), v.id]));
  const wanted = [...new Set(plates.map(normalizePlate))].filter((p) => idByPlate.has(p));

  const out = [];
  const pending = [];
  for (const plate of wanted) {
    const hit = liveCache.get(plate);
    if (hit && Date.now() - hit.at < LIVE_TTL_MS) {
      if (hit.position) out.push(hit.position);
    } else pending.push(plate);
  }
  for (let i = 0; i < pending.length; i += LIVE_CONCURRENCY) {
    const slice = pending.slice(i, i + LIVE_CONCURRENCY);
    const results = await Promise.all(
      slice.map((plate) =>
        fetchLatest(idByPlate.get(plate), plate)
          .then((position) => ({ plate, position }))
          .catch(() => ({ plate, position: undefined }))
      )
    );
    for (const { plate, position } of results) {
      // Un error de la consulta no se guarda (se reintenta en la siguiente); "sin datos" si.
      if (position === undefined) continue;
      liveCache.set(plate, { at: Date.now(), position });
      if (position) out.push(position);
    }
  }
  return out;
};
