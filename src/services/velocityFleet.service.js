import { env } from "../config/env.js";

// Integracion con Velocity Fleet (GPS de vehiculo, seccion Mapa) - ver
// https://api-docs.velocityfleet.com. Todo el archivo es best-effort, mismo criterio
// que routing.service.js/geocoding.service.js: si algo falla aca (token no
// configurado, Velocity Fleet caido, etc.) nunca debe romper el Mapa - simplemente
// esos vehiculos siguen mostrando la ubicacion del celular del chofer (ver
// listVehicleLivePositionsForActor en vehicle.service.js, que atrapa cualquier
// error de aca).
const BASE_URL = "https://www.velocityfleet.com";

// El Access Token real dura 30 dias (ver doc de Authentication) - se cachea en memoria
// del proceso y se renueva un poco antes de vencer, para no pedir uno nuevo en cada
// consulta de posiciones.
let cachedAccessToken = null;
let accessTokenExpiresAt = 0;
const ACCESS_TOKEN_TTL_MS = 29 * 24 * 60 * 60 * 1000;

const fetchAccessToken = async () => {
  const form = new URLSearchParams();
  // .trim(): un espacio o salto de linea de mas al pegar el token en las variables de
  // entorno (Render, .env local) rompe la renovacion en silencio - Velocity Fleet
  // puede responder 200 igual pero sin un token real adentro, y recien ahi explota
  // (401) en la consulta de posiciones, con un mensaje que no dice nada de esto.
  form.set("token", env.VELOCITY_FLEET_REFRESH_TOKEN.trim());

  const res = await fetch(`${BASE_URL}/vapi/v1/accounts/users/oauth2/refresh/`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`no se pudo renovar el access token (${res.status})`);

  const data = await res.json();
  if (!data.token) {
    throw new Error(
      "Velocity Fleet no devolvio un access token valido al renovar - revisar que " +
        "VELOCITY_FLEET_REFRESH_TOKEN este bien copiado (sin espacios/saltos de linea de mas)"
    );
  }
  return data.token;
};

const getAccessToken = async () => {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt) return cachedAccessToken;

  cachedAccessToken = await fetchAccessToken();
  accessTokenExpiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
  return cachedAccessToken;
};

const authFetch = async (path, options = {}) => {
  const token = await getAccessToken();
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
};

// El customer_id (no el "number") se necesita para /device-live-positions - se
// resuelve una sola vez y se cachea, la cuenta de Gamonal tiene un solo cliente
// asociado. Si alguna vez tuviera mas de uno, se prioriza el que diga "Telematics"
// en su producto (que es lo que necesitamos), y si no hay forma de distinguir se usa
// el primero en vez de fallar.
let cachedCustomerId = null;

const getCustomerId = async () => {
  if (cachedCustomerId) return cachedCustomerId;

  const res = await authFetch("/vapi/v1/accounts/users/customers");
  if (!res.ok) throw new Error(`no se pudo listar clientes (${res.status})`);

  const customers = await res.json();
  const ids = Object.keys(customers);
  if (ids.length === 0) throw new Error("la cuenta no tiene clientes asociados");

  // "product" no siempre viene como string simple (el ejemplo de la doc mostraba
  // "Fuel & Telematics", pero en la practica la cuenta de Gamonal tiene VARIOS
  // customers, cada uno con su propio "product" como objeto indexado numericamente,
  // ej. {"1":"Fuel"} o {"2":"Telematics"} - el customer de Fuel no tiene datos de GPS,
  // hay que quedarse con el de Telematics. Se soporta string, array u objeto (los
  // valores del objeto), y cualquier otra forma simplemente no matchea en vez de
  // romper la resolucion del cliente.
  const includesTelematics = (product) => {
    if (typeof product === "string") return product.includes("Telematics");
    if (Array.isArray(product)) return product.some((p) => String(p).includes("Telematics"));
    if (product && typeof product === "object") {
      return Object.values(product).some((p) => String(p).includes("Telematics"));
    }
    return false;
  };

  const telematicsId = ids.find((id) => includesTelematics(customers[id].product));
  cachedCustomerId = telematicsId ?? ids[0];
  return cachedCustomerId;
};

// Cache corto (no el token, la respuesta de posiciones): varias pestanias del Mapa
// abiertas a la vez pollean cada una por su cuenta (ver REFRESH_INTERVAL_MS en
// MapPage.jsx) - sin esto se multiplicaria la consulta a Velocity Fleet sin necesidad.
// 25s: por debajo del refresco del Mapa (30s), asi que nunca devuelve un dato mas
// viejo que el intervalo real del front.
const POSITIONS_CACHE_MS = 25000;
let cachedPositions = null;
let cachedPositionsAt = 0;

const normalizeTarga = (targa) => targa?.replace(/\s+/g, "").toUpperCase() ?? "";

// Monitoreo de uso (punto 6 del pedido de optimizacion de costos): cuenta las
// consultas REALES a Velocity Fleet (no las que salen del cache de arriba, que no
// cuestan nada) y deja un log cada tanto - para poder notar un pico anormal (ej. un
// bug que rompa el cache y empiece a pegarle a la API sin parar) antes de que
// impacte en la factura de Velocity Fleet. En memoria del proceso, sin tabla nueva -
// una tabla de logs en Neon para "vigilar costos" seria contradictorio.
let velocityFleetCallCount = 0;
let velocityFleetCallCountSince = Date.now();
const CALL_LOG_EVERY = 20;

export const getVelocityFleetUsageStats = () => ({
  callsSinceReset: velocityFleetCallCount,
  sinceMs: Date.now() - velocityFleetCallCountSince,
});

const trackVelocityFleetCall = () => {
  velocityFleetCallCount += 1;
  if (velocityFleetCallCount % CALL_LOG_EVERY === 0) {
    const minutes = ((Date.now() - velocityFleetCallCountSince) / 60000).toFixed(1);
    console.log(
      `[velocityFleet] ${velocityFleetCallCount} consultas reales a la API en los ultimos ${minutes} min`
    );
  }
};

// [{ targa, lat, lng, speed, ignition, direction, updatedAt }] - vehicle_registration
// es la targa (confirmado en la doc de Device Positions); lat/lon vienen asi (no
// lat/lng) en la respuesta cruda de Velocity Fleet, se normaliza el nombre aca.
// Una posicion mas vieja que esto se considera sin senal (vehiculo apagado, GPS caido).
const VEHICLE_POSITION_FRESH_MINUTES = 30;

// Posicion actual de un vehiculo puntual por targa, o null si no tiene GPS, no hay datos
// recientes o Velocity Fleet no responde. Usa la misma cache de getVehicleLivePositions,
// asi que pedir varias seguidas no suma llamadas a su API.
export const getFreshVehiclePositionByTarga = async (targa) => {
  if (!targa) return null;
  let positions;
  try {
    positions = await getVehicleLivePositions();
  } catch {
    return null;
  }
  const position = positions.find((p) => p.targa === normalizeTarga(targa));
  if (!position) return null;
  if (position.updatedAt && Date.now() - position.updatedAt.getTime() > VEHICLE_POSITION_FRESH_MINUTES * 60000) {
    return null;
  }
  return position;
};

export const getVehicleLivePositions = async () => {
  if (!env.VELOCITY_FLEET_REFRESH_TOKEN) return [];

  if (cachedPositions && Date.now() - cachedPositionsAt < POSITIONS_CACHE_MS) {
    return cachedPositions;
  }

  const customerId = await getCustomerId();
  trackVelocityFleetCall();
  const res = await authFetch(`/api/mobile/kinesis/device-live-positions/?customer=${customerId}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`no se pudo consultar posiciones (${res.status})`);

  const data = await res.json();
  const positions = (data.devices ?? [])
    .filter((d) => d.vehicle_registration && d.lat != null && d.lon != null)
    .map((d) => ({
      targa: normalizeTarga(d.vehicle_registration),
      lat: d.lat,
      lng: d.lon,
      speed: d.speed ?? null,
      // No asumir km/h: la cuenta puede estar configurada en MPH (ver
      // speed_measure_text en la respuesta cruda) - se muestra tal cual en el front.
      speedUnit: d.speed_measure_text ?? null,
      ignition: d.ignition === "Y",
      direction: d.direction ?? null,
      updatedAt: d.timestamp ? new Date(Number(d.timestamp) * 1000) : null,
    }));

  cachedPositions = positions;
  cachedPositionsAt = Date.now();
  return positions;
};
