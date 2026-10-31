import { AppError } from "../utils/AppError.js";
import { distanceMeters } from "../utils/stopDetection.js";
import { geocodeAddress, geocodePreview } from "./geocoding.service.js";
import { calculateRoute, osrmTable, routeWithTimeline } from "./routing.service.js";

// Punto de encuentro entre dos vehiculos (Mapa): donde pueden juntarse llegando al mismo tiempo manejando. Si se encuentran en un punto de la
// ruta mas rapida entre ambos, cada uno tarda la mitad del viaje (cualquier punto fuera de esa ruta les cuesta mas a los dos), asi que el punto
// ideal es el que esta a la mitad del TIEMPO de esa ruta. Como suele caer en medio de una autopista, se buscan sitios reales para parar
// (areas de servicio, descanso, gasolineras, parkings de camiones) cerca de ese punto y se calcula el tiempo exacto de cada uno hasta ellos.
// Los tiempos son los de OSRM: sin trafico.

// Cuanto se busca a cada lado del punto ideal (minutos de manejo desde el ideal) y a que distancia de la ruta (metros).
const VENTANA_MIN = 45;
const RADIO_RUTA_M = 3000;
// Puntos de la ruta que se le pasan a Overpass (mas puntos = consulta mas pesada) y sitios que se miden contra OSRM.
const MAX_PUNTOS_CONSULTA = 40;
const MAX_CANDIDATOS = 30;
const MAX_SUGERENCIAS = 6;
// Dos sitios a menos de esta distancia son el mismo (la gasolinera de un area de servicio es el area de servicio).
const DUPLICADO_M = 400;
const MISMO_LUGAR_M = 1000;

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const OVERPASS_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 50;

const TIPOS = {
  services: { label: "Área de servicio", prioridad: 0 },
  rest_area: { label: "Área de descanso", prioridad: 1 },
  parking: { label: "Parking de camiones", prioridad: 2 },
  fuel: { label: "Gasolinera", prioridad: 3 },
};

const cache = new Map();

// Un origen es un vehiculo/posicion { lat, lng } o una direccion escrita { direccion }.
const resolvePoint = async (origin) => {
  if (origin.lat != null && origin.lng != null) return { lat: origin.lat, lng: origin.lng, label: origin.label ?? null };
  const { lat, lng } = await geocodeAddress(origin.direccion);
  const label = await geocodePreview(origin.direccion).catch(() => null);
  return { lat, lng, label: label ?? origin.direccion };
};

// Posicion (indice del trazado) donde se cumple "min" minutos de manejo desde el inicio.
const indexAtMinutes = (cumMin, min) => {
  let lo = 0;
  let hi = cumMin.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumMin[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const pointAt = (ruta, index) => {
  const [lng, lat] = ruta.geometria.coordinates[index];
  return { lat, lng };
};

// Indice del punto del trazado (dentro de [from, to]) mas cercano a "place", y a que distancia esta.
const nearestIndex = (coords, from, to, place) => {
  let best = from;
  let bestM = Infinity;
  for (let i = from; i <= to; i += 1) {
    const m = distanceMeters(place, { lat: coords[i][1], lng: coords[i][0] });
    if (m < bestM) {
      bestM = m;
      best = i;
    }
  }
  return { index: best, meters: bestM };
};

const sample = (coords, from, to, max) => {
  const step = Math.max(1, Math.ceil((to - from + 1) / max));
  const out = [];
  for (let i = from; i <= to; i += step) out.push(coords[i]);
  const last = coords[to];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
};

const overpassQuery = (path) => {
  const poly = path.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(",");
  const around = `(around:${RADIO_RUTA_M},${poly})`;
  return `[out:json][timeout:12];(
    nwr${around}["highway"~"^(services|rest_area)$"];
    nwr${around}["amenity"="fuel"];
    nwr${around}["amenity"="parking"]["hgv"~"^(yes|designated)$"];
  );out center 250;`;
};

const fetchOverpass = async (query) => {
  const attempts = OVERPASS_URLS.map(async (base) => {
    const response = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GamonalDriver/1.0", Accept: "application/json" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.elements)) throw new Error("Overpass sin elementos");
    return data.elements;
  });
  // El primero que responda: los servidores publicos de Overpass se cuelgan seguido.
  return Promise.any(attempts);
};

const tipoDe = (tags = {}) => {
  if (tags.highway === "services") return "services";
  if (tags.highway === "rest_area") return "rest_area";
  if (tags.amenity === "parking") return "parking";
  return "fuel";
};

// Sitios para parar cerca del trazado [from, to]. null si Overpass no respondio (se avisa, no se rompe: queda el punto ideal).
const findPlaces = async (ruta, from, to) => {
  const coords = ruta.geometria.coordinates;
  const path = sample(coords, from, to, MAX_PUNTOS_CONSULTA);
  const key = path.map(([lng, lat]) => `${lat.toFixed(3)},${lng.toFixed(3)}`).join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let elements;
  try {
    elements = await fetchOverpass(overpassQuery(path));
  } catch (err) {
    console.error("[puntoEncuentro] Overpass no respondio:", err?.errors?.map((e) => e.message).join(" | ") ?? err?.message);
    return null;
  }

  const places = elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) return null;
      const tipo = tipoDe(el.tags);
      const nombre = el.tags?.name ?? el.tags?.brand ?? el.tags?.operator ?? null;
      return { lat, lng, tipo, nombre: nombre ?? TIPOS[tipo].label, conNombre: Boolean(nombre) };
    })
    .filter(Boolean)
    // Los mas "importantes" primero, para que un area de servicio gane a la gasolinera que tiene al lado.
    .sort((p, q) => TIPOS[p.tipo].prioridad - TIPOS[q.tipo].prioridad || Number(q.conNombre) - Number(p.conNombre));

  const unique = [];
  for (const p of places) if (!unique.some((u) => distanceMeters(u, p) < DUPLICADO_M)) unique.push(p);

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value: unique });
  return unique;
};

const round = (value, decimals = 1) => Math.round(value * 10 ** decimals) / 10 ** decimals;

const buildRoute = async (pa, pb) => {
  if (distanceMeters(pa, pb) < MISMO_LUGAR_M) throw new AppError("Los dos puntos están a menos de 1 km: ya están en el mismo lugar.", 422);
  const ruta = await routeWithTimeline(pa, pb);
  if (!ruta) throw new AppError("No se pudo calcular la ruta entre los dos puntos. Intenta de nuevo en un momento.", 503);
  return ruta;
};

// Paso rapido: la ruta entre a y b y el punto ideal (mitad del tiempo), sin esperar a Overpass. a y b son vehiculos/posiciones o direcciones.
export const findMeetingPointForActor = async ({ a, b }) => {
  const [pa, pb] = await Promise.all([resolvePoint(a), resolvePoint(b)]);
  const ruta = await buildRoute(pa, pb);

  const total = ruta.duracionMin;
  const mitad = indexAtMinutes(ruta.cumMin, total / 2);
  return {
    a: pa,
    b: pb,
    ruta: { distanciaKm: round(ruta.distanciaKm), duracionMin: round(total), geometria: ruta.geometria },
    ideal: {
      ...pointAt(ruta, mitad),
      minA: round(ruta.cumMin[mitad]),
      minB: round(total - ruta.cumMin[mitad]),
      kmA: round(ruta.cumKm[mitad]),
      kmB: round(ruta.distanciaKm - ruta.cumKm[mitad]),
    },
  };
};

// Paso lento (Overpass puede tardar o estar caido): sitios reales para parar cerca del punto ideal, con el tiempo exacto de cada uno hasta
// ellos, ordenados por quien llega ultimo (cuando se produce el encuentro) mas la mitad de la espera del que llega antes. a y b ya son coordenadas.
export const findMeetingSuggestionsForActor = async ({ a, b }) => {
  const ruta = await buildRoute(a, b);
  const total = ruta.duracionMin;
  const from = indexAtMinutes(ruta.cumMin, Math.max(0, total / 2 - VENTANA_MIN));
  const to = indexAtMinutes(ruta.cumMin, Math.min(total, total / 2 + VENTANA_MIN));

  const places = await findPlaces(ruta, from, to);
  if (places === null) {
    return { sugerencias: [], aviso: "No se pudieron cargar los sitios para parar (el servicio de mapas no respondió). Se muestra solo el punto exacto de la ruta." };
  }

  // Primera seleccion sin llamar a nadie: se estima el tiempo de cada sitio con el punto de la ruta mas cercano.
  const candidatos = places
    .map((p) => {
      const { index, meters } = nearestIndex(ruta.geometria.coordinates, from, to, p);
      return { ...p, estimado: Math.abs(2 * ruta.cumMin[index] - total) + (meters / 1000) * 1.5 };
    })
    .filter((p) => p.estimado <= VENTANA_MIN * 2)
    .sort((p, q) => p.estimado - q.estimado)
    .slice(0, MAX_CANDIDATOS);
  if (candidatos.length === 0) {
    return { sugerencias: [], aviso: "No se encontraron áreas de servicio ni gasolineras cerca del punto de encuentro. Se muestra solo el punto exacto de la ruta." };
  }

  const table = await osrmTable([a, b], candidatos);
  if (!table) {
    return { sugerencias: [], aviso: "No se pudieron calcular los tiempos hasta los sitios sugeridos. Se muestra solo el punto exacto de la ruta." };
  }

  const sugerencias = candidatos
    .map((p, i) => {
      const minA = table.duraciones[0][i];
      const minB = table.duraciones[1][i];
      if (minA == null || minB == null) return null;
      const diff = Math.abs(minA - minB);
      return {
        nombre: p.nombre,
        tipo: p.tipo,
        tipoLabel: TIPOS[p.tipo].label,
        lat: p.lat,
        lng: p.lng,
        minA: round(minA),
        minB: round(minB),
        kmA: round(table.distancias[0][i]),
        kmB: round(table.distancias[1][i]),
        diffMin: round(diff),
        score: Math.max(minA, minB) + diff / 2,
      };
    })
    .filter(Boolean)
    .sort((p, q) => p.score - q.score)
    .slice(0, MAX_SUGERENCIAS)
    .map(({ score, ...rest }) => rest);
  return { sugerencias, aviso: null };
};

// Las dos rutas hasta el punto elegido (para dibujarlas en el mapa).
export const getMeetingRoutesForActor = async ({ a, b, punto }) => {
  const [rutaA, rutaB] = await Promise.all([calculateRoute([a, punto]), calculateRoute([b, punto])]);
  const pick = (r) => (r ? { distanciaKm: round(r.distanciaKm), duracionMin: round(r.duracionMin), geometria: r.geometria } : null);
  return { rutaA: pick(rutaA), rutaB: pick(rutaB) };
};
