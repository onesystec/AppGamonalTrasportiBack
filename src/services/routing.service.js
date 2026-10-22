import { env } from "../config/env.js";

const OSRM_TIMEOUT_MS = 8000;

// Ruta de OSRM (la de siempre: la mas rapida, con peajes si conviene).
const osrmRoute = async (points) => {
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = new URL(`/route/v1/driving/${coords}`, env.OSRM_BASE_URL);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");

    // El servidor publico de OSRM a veces se cuelga: sin limite, el servicio quedaba esperando. Si no responde a tiempo se
    // guarda sin ruta (se puede recalcular despues) en vez de hacer esperar a quien lo carga.
    const response = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
    if (!response.ok) return null;

    const data = await response.json();
    if (data.code !== "Ok" || !data.routes?.length) return null;

    const [route] = data.routes;
    return {
      distanciaKm: route.distance / 1000,
      duracionMin: route.duration / 60,
      geometria: route.geometry,
      // Distancia y duracion de cada tramo entre un punto y el siguiente.
      tramos: (route.legs ?? []).map((leg) => ({ distanciaKm: leg.distance / 1000, duracionMin: leg.duration / 60 })),
      motor: "osrm",
      evitoPeajes: false,
    };
  } catch {
    return null;
  }
};

// Polyline de Valhalla (precision 6) -> [[lng, lat], ...].
const decodePolyline6 = (encoded) => {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of ["lat", "lng"]) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === "lat") lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
};

const VALHALLA_TIMEOUT_MS = 20000;

// Ruta de Valhalla. Por defecto evita los peajes (use_tolls=0): lo que el chofer declara cuando dice que no uso peaje. Con peajes: true los
// permite (use_tolls=0.5, el valor normal de Valhalla): se usa para rodear el centro de Milan por las tangenciales. Mismo formato que la de
// OSRM, mas "usaPeaje" (Valhalla dice si la ruta que eligio lleva algun peaje: con peajes: false solo pasa si no hay otro camino).
const valhallaRoute = async (points, { peajes = false } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALHALLA_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/route", env.VALHALLA_BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "GamonalDriver/1.0" },
      body: JSON.stringify({
        locations: points.map((p) => ({ lat: p.lat, lon: p.lng, type: "break" })),
        costing: "auto",
        costing_options: { auto: { use_tolls: peajes ? 0.5 : 0 } },
        directions_options: { units: "kilometers" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const { trip } = await response.json();
    if (!trip?.legs?.length) return null;

    const coordinates = [];
    trip.legs.forEach((leg, i) => {
      const shape = decodePolyline6(leg.shape);
      coordinates.push(...(i === 0 ? shape : shape.slice(1)));
    });
    return {
      distanciaKm: trip.summary.length,
      duracionMin: trip.summary.time / 60,
      geometria: { type: "LineString", coordinates },
      tramos: trip.legs.map((leg) => ({ distanciaKm: leg.summary.length, duracionMin: leg.summary.time / 60 })),
      motor: "valhalla",
      evitoPeajes: !peajes,
      usaPeaje: Boolean(trip.summary.has_toll),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// "El centro de Milan": 3 km alrededor del Duomo. Una ruta que mete varios puntos de su trazado ahi esta cruzando la ciudad. Si el servicio tiene
// una parada (o la salida) dentro del centro es normal que entre, y no se toca.
const DUOMO = { lat: 45.4642, lng: 9.19 };
const CENTRO_RADIO_KM = 3;
const CENTRO_PUNTOS_MIN = 8;
const kmAlDuomo = (lat, lng) => Math.hypot((lat - DUOMO.lat) * 111, (lng - DUOMO.lng) * 111 * Math.cos((DUOMO.lat * Math.PI) / 180));
export const cruzaElCentroDeMilan = (geometria, points) => {
  if (points.some((p) => kmAlDuomo(p.lat, p.lng) <= CENTRO_RADIO_KM + 0.5)) return false;
  let dentro = 0;
  for (const [lng, lat] of geometria?.coordinates ?? []) {
    if (kmAlDuomo(lat, lng) <= CENTRO_RADIO_KM && (dentro += 1) >= CENTRO_PUNTOS_MIN) return true;
  }
  return false;
};

// Calcula distancia/duracion/geometria de la ruta que pasa por "points" en orden (points[0] es siempre el deposito). Con
// evitarPeajes la ruta no usa autopistas de pago (si Valhalla no responde, se devuelve la de OSRM con evitoPeajes: false para que quien
// la llama sepa que no se pudo garantizar). Best-effort: los servidores publicos pueden fallar o estar caidos, y eso NO debe bloquear la
// creacion/edicion del servicio - en ese caso se devuelve null y el registro se guarda igual, sin ruta calculada.
export const calculateRoute = async (points, { evitarPeajes = false } = {}) => {
  if (evitarPeajes) {
    const route = await valhallaRoute(points);
    if (route) return route;
  }
  const route = await osrmRoute(points);
  if (!route || evitarPeajes || !cruzaElCentroDeMilan(route.geometria, points)) return route;
  // OSRM no conoce el trafico y a veces manda a la furgoneta por el medio de Milan, que nadie hace: se recalcula con Valhalla, que rodea
  // la ciudad por las tangenciales (en una ruta de Milan Este a Busto Arsizio dio 140 km contra 138 de Google; OSRM, 107 por el centro). Solo se
  // cambia si la nueva no cruza el centro y no es absurdamente mas larga; si no, queda la de OSRM.
  const rodeo = await valhallaRoute(points, { peajes: true });
  if (rodeo && !cruzaElCentroDeMilan(rodeo.geometria, points) && rodeo.distanciaKm <= route.distanciaKm * 1.8) return rodeo;
  return route;
};

// El servidor publico de OSRM no matchea trazas muy largas en una sola llamada -
// se parte en tandas conservadoras (como el limite de 100 puntos de Google Roads API).
const MATCH_CHUNK_SIZE = 100;

// Radio de busqueda (metros) que se le pasa a cada punto para el matching. No se
// guarda la precision real del GPS del celular, asi que se usa un valor generoso fijo
// en vez de asumir la precision de un GPS de auto con hardware dedicado.
const GPS_MATCH_RADIUS_METERS = 30;

const snapChunk = async (chunk) => {
  if (chunk.length < 2) return chunk;

  try {
    const coords = chunk.map((p) => `${p.lng},${p.lat}`).join(";");
    const timestamps = chunk.map((p) => Math.floor(new Date(p.recordedAt).getTime() / 1000)).join(";");
    const radiuses = chunk.map(() => GPS_MATCH_RADIUS_METERS).join(";");

    const url = new URL(`/match/v1/driving/${coords}`, env.OSRM_BASE_URL);
    url.searchParams.set("overview", "false");
    url.searchParams.set("timestamps", timestamps);
    url.searchParams.set("radiuses", radiuses);

    const response = await fetch(url);
    if (!response.ok) return chunk;

    const data = await response.json();
    if (data.code !== "Ok" || !data.tracepoints) return chunk;

    return data.tracepoints.map((tracepoint, i) =>
      tracepoint?.location
        ? { ...chunk[i], lat: tracepoint.location[1], lng: tracepoint.location[0] }
        : chunk[i]
    );
  } catch {
    return chunk;
  }
};

// Ajusta el recorrido real de un chofer (ver LocationPing) a la calle vehicular mas
// cercana, asi un desvio peatonal (el chofer caminando dentro de una casa o de una
// oficina para entregar) no se ve en el mapa como si fuera parte del trayecto en
// vehiculo. Best-effort y por tanda: si el matching de una tanda falla o no matchea
// algun punto puntual, esos puntos se devuelven tal cual en vez de romper la ruta
// completa.
export const snapPointsToRoad = async (points) => {
  if (points.length < 2) return points;

  const chunks = [];
  for (let i = 0; i < points.length; i += MATCH_CHUNK_SIZE) {
    chunks.push(points.slice(i, i + MATCH_CHUNK_SIZE));
  }

  const snappedChunks = await Promise.all(chunks.map(snapChunk));
  return snappedChunks.flat();
};
