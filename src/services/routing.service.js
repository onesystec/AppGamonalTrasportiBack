import { env } from "../config/env.js";

// Calcula distancia/duracion/geometria de la ruta que pasa por "points" en orden
// (points[0] es siempre el deposito). Best-effort: el servidor demo publico de OSRM
// puede fallar o estar caido, y eso NO debe bloquear la creacion/edicion del servicio -
// en ese caso se devuelve null y el registro se guarda igual, sin ruta calculada.
export const calculateRoute = async (points) => {
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = new URL(`/route/v1/driving/${coords}`, env.OSRM_BASE_URL);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");

    const response = await fetch(url);
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
    };
  } catch {
    return null;
  }
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
