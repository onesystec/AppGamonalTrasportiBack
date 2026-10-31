import { readFileSync } from "node:fs";
import { AppError } from "../utils/AppError.js";
import { distanceMeters } from "../utils/stopDetection.js";
import { geocodeAddress, geocodePreview } from "./geocoding.service.js";
import { calculateRoute, osrmTable, routeWithTimeline } from "./routing.service.js";

// Punto de encuentro entre dos vehiculos (Mapa): donde pueden juntarse llegando al mismo tiempo manejando. Si se encuentran en un punto de la
// ruta mas rapida entre ambos, cada uno tarda la mitad del viaje (cualquier punto fuera de esa ruta les cuesta mas a los dos), asi que el punto
// ideal es el que esta a la mitad del TIEMPO de esa ruta. Como suele caer en medio de una autopista, se buscan sitios reales para parar
// (areas de servicio, descanso, parkings de camiones) cerca de ese punto y se calcula el tiempo exacto de cada uno hasta ellos. Los sitios salen
// de un archivo fijo (data/areas-parada-italia.json, de OpenStreetMap, se regenera con scripts/importar-areas-parada-osm.mjs), sin depender de ningun
// servicio externo en el momento de buscar. Los tiempos son los de OSRM: sin trafico.

// Cuanto se busca a cada lado del punto ideal (minutos de manejo desde el ideal) y a que distancia de la ruta (metros).
const VENTANA_MIN = 45;
const RADIO_RUTA_M = 3000;
// Sitios que se miden contra OSRM.
const MAX_CANDIDATOS = 30;
const MAX_SUGERENCIAS = 6;
const MISMO_LUGAR_M = 1000;

const TIPOS = {
  services: { label: "Área de servicio" },
  rest_area: { label: "Área de descanso" },
  parking: { label: "Parking de camiones" },
};

// Archivo fijo: [{ t: "services" | "rest_area" | "parking", n: nombre | null, la, lo }].
let areasCache = null;
const loadAreas = () => {
  areasCache ??= JSON.parse(readFileSync(new URL("../../data/areas-parada-italia.json", import.meta.url), "utf8"));
  return areasCache;
};

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

// Sitios del archivo fijo a menos de RADIO_RUTA_M del trazado [from, to].
const findPlaces = (ruta, from, to) => {
  const coords = ruta.geometria.coordinates;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (let i = from; i <= to; i += 1) {
    const [lng, lat] = coords[i];
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  const margin = 0.05;
  return loadAreas()
    .filter((p) => p.la >= minLat - margin && p.la <= maxLat + margin && p.lo >= minLng - margin && p.lo <= maxLng + margin)
    .map((p) => {
      const tipo = p.t;
      return { lat: p.la, lng: p.lo, tipo, nombre: p.n ?? TIPOS[tipo].label };
    });
};

const round = (value, decimals = 1) => Math.round(value * 10 ** decimals) / 10 ** decimals;

const buildRoute = async (pa, pb) => {
  if (distanceMeters(pa, pb) < MISMO_LUGAR_M) throw new AppError("Los dos puntos están a menos de 1 km: ya están en el mismo lugar.", 422);
  const ruta = await routeWithTimeline(pa, pb);
  if (!ruta) throw new AppError("No se pudo calcular la ruta entre los dos puntos. Intenta de nuevo en un momento.", 503);
  return ruta;
};

// Paso rapido: la ruta entre a y b y el punto ideal (mitad del tiempo). a y b son vehiculos/posiciones o direcciones.
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

// Sitios reales para parar cerca del punto ideal, con el tiempo exacto de cada uno hasta
// ellos, ordenados por quien llega ultimo (cuando se produce el encuentro) mas la mitad de la espera del que llega antes. a y b ya son coordenadas.
export const findMeetingSuggestionsForActor = async ({ a, b }) => {
  const ruta = await buildRoute(a, b);
  const total = ruta.duracionMin;
  const from = indexAtMinutes(ruta.cumMin, Math.max(0, total / 2 - VENTANA_MIN));
  const to = indexAtMinutes(ruta.cumMin, Math.min(total, total / 2 + VENTANA_MIN));

  const places = findPlaces(ruta, from, to);

  // Primera seleccion sin llamar a nadie: se estima el tiempo de cada sitio con el punto de la ruta mas cercano.
  const candidatos = places
    .map((p) => {
      const { index, meters } = nearestIndex(ruta.geometria.coordinates, from, to, p);
      return { ...p, meters, estimado: Math.abs(2 * ruta.cumMin[index] - total) + (meters / 1000) * 1.5 };
    })
    .filter((p) => p.meters <= RADIO_RUTA_M && p.estimado <= VENTANA_MIN * 2)
    .sort((p, q) => p.estimado - q.estimado)
    .slice(0, MAX_CANDIDATOS);
  if (candidatos.length === 0) {
    return { sugerencias: [], aviso: "No se encontraron áreas de servicio, de descanso ni parkings de camiones cerca del punto de encuentro. Se muestra solo el punto exacto de la ruta." };
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
