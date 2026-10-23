import { pointInPolygon } from "./pointInPolygon.js";

// Comparacion del recorrido real de un vehiculo (puntos GPS) con la ruta planificada. Todo en un plano local en metros (suficiente para rutas de
// unos cientos de km en Italia). Funciones puras: no tocan la base ni la red.

const EARTH_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export const haversineM = (a, b) => {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
};

// Proyeccion local: x/y en metros respecto a un punto de referencia.
const makeProjector = (lat0) => {
  const k = Math.cos(rad(lat0)) * 111320;
  return (lat, lng) => ({ x: lng * k, y: lat * 110540 });
};

const pointSegmentM = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

// Indice de segmentos de la ruta planificada en una cuadricula (celdas de 500 m): la distancia de un punto a la ruta solo mira las celdas cercanas
// en vez de todos los segmentos (rutas de miles de puntos contra miles de puntos del GPS).
const CELL_M = 500;
export const buildPlanIndex = (coords) => {
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const project = makeProjector(lat0);
  const pts = coords.map(([lng, lat]) => project(lat, lng));
  const cells = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  for (let i = 1; i < pts.length; i += 1) {
    const [a, b] = [pts[i - 1], pts[i]];
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx += 1) {
      for (let cy = Math.floor(y0 / CELL_M); cy <= Math.floor(y1 / CELL_M); cy += 1) {
        const k = key(cx, cy);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
    }
  }
  const distanceM = (lat, lng) => {
    const p = project(lat, lng);
    const cx = Math.floor(p.x / CELL_M);
    const cy = Math.floor(p.y / CELL_M);
    // Celdas vecinas (hasta ~1,5 km); si la ruta no pasa por ahi, se mira entera (el punto esta lejos y el valor exacto importa).
    let best = Infinity;
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dy = -3; dy <= 3; dy += 1) {
        const list = cells.get(key(cx + dx, cy + dy));
        if (!list) continue;
        for (const i of list) best = Math.min(best, pointSegmentM(p, pts[i - 1], pts[i]));
      }
    }
    if (best <= 1500) return best;
    for (let i = 1; i < pts.length; i += 1) best = Math.min(best, pointSegmentM(p, pts[i - 1], pts[i]));
    return best;
  };
  return { distanceM };
};

// Se descartan puntos sin coordenadas, se ordenan por hora y se juntan los que estan a menos de minM del anterior (un vehiculo parado manda
// puntos casi iguales): queda un recorrido liviano, pero siempre con el primero, el ultimo y un punto cada maxGapMs para no perder los tiempos.
export const decimateTrack = (rows, { minM = 40, maxGapMs = 2 * 60 * 1000 } = {}) => {
  const sorted = rows
    .filter((r) => r.lat != null && r.lng != null && Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .map((r) => ({ at: new Date(r.at).getTime(), lat: r.lat, lng: r.lng, speed: r.speed ?? null }))
    .sort((a, b) => a.at - b.at);
  const out = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (!last || haversineM(last, p) >= minM || p.at - last.at >= maxGapMs) out.push(p);
  }
  if (sorted.length && out.at(-1) !== sorted.at(-1)) out.push(sorted.at(-1));
  return out;
};

export const trackLengthKm = (points) => {
  let m = 0;
  for (let i = 1; i < points.length; i += 1) m += haversineM(points[i - 1], points[i]);
  return m / 1000;
};

// Douglas-Peucker en metros: deja la forma del recorrido con pocos puntos (para guardarlo y dibujarlo). Si aun asi hay mas de maxPoints, sube la
// tolerancia hasta que entre.
const simplifyOnce = (pts, tolM) => {
  if (pts.length <= 2) return pts.map((_, i) => i);
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const project = makeProjector(lat0);
  const xy = pts.map((p) => project(p.lat, p.lng));
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i += 1) {
      const d = pointSegmentM(xy[i], xy[s], xy[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tolM) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return keep.flatMap((k, i) => (k ? [i] : []));
};

export const simplifyTrack = (points, { tolM = 15, maxPoints = 1200 } = {}) => {
  let tol = tolM;
  let idx = simplifyOnce(points, tol);
  while (idx.length > maxPoints && tol < 500) {
    tol *= 1.5;
    idx = simplifyOnce(points, tol);
  }
  return idx.map((i) => points[i]);
};

// Si una ruta (lista [[lng, lat], ...]) pasa por dentro de un poligono: se recorre cada tramo de a ~150 m (los tramos de una ruta pueden ser largos
// y saltarse un poligono chico como el Area C).
export const routeCrossesPolygon = (coords, polygon) => {
  for (let i = 1; i < coords.length; i += 1) {
    const [a, b] = [{ lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] }];
    const steps = Math.max(1, Math.ceil(haversineM(a, b) / 150));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      if (pointInPolygon({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, polygon)) return true;
    }
  }
  return false;
};

const round5 = (n) => Math.round(n * 1e5) / 1e5;
export const toLineString = (points) => ({ type: "LineString", coordinates: points.map((p) => [round5(p.lng), round5(p.lat)]) });

// Umbrales: a mas de OFF_M de la ruta planificada se esta "fuera de ruta"; un tramo fuera de ruta solo se destaca desde TRAMO_MIN_KM, y solo se
// pide revisarlo desde TRAMO_REVISAR_KM o TRAMO_REVISAR_MIN minutos (un desvio de 1-2 km por un cierre o un atasco es normal).
export const THRESHOLDS = {
  OFF_M: 400,
  TRAMO_MIN_KM: 1.5,
  TRAMO_REVISAR_KM: 3,
  TRAMO_REVISAR_MIN: 10,
  EXTRA_KM_REVISAR: 10,
  EXTRA_PCT_REVISAR: 0.15,
  ARRIVAL_M: 300,
};

// Compara el recorrido real con la ruta planificada de ida.
//  planCoords: [[lng, lat], ...] de la ruta planificada (ida).
//  rows: puntos del GPS { at, lat, lng, speed }.
//  finalStop: { lat, lng } de la ultima parada (para saber hasta donde es la ida y si llego), o null.
//  kmPlan: km de la ruta planificada, si se conocen.
//  areaCPath: poligono del Area C [{ lat, lng }], opcional.
// Devuelve el resumen (sin la geometria) y la linea real simplificada.
export const compareTracks = ({ planCoords, rows, finalStop = null, kmPlan = null, areaCPath = null }) => {
  const T = THRESHOLDS;
  const track = decimateTrack(rows);
  if (track.length < 3 || !planCoords || planCoords.length < 2) return null;

  // Hasta donde llega la ida: el primer punto a menos de ARRIVAL_M de la ultima parada. Lo que sigue es la vuelta (no se compara con la ida).
  let arrivalIdx = -1;
  if (finalStop) arrivalIdx = track.findIndex((p) => haversineM(p, finalStop) <= T.ARRIVAL_M);
  const llego = arrivalIdx !== -1;
  const ida = llego ? track.slice(0, arrivalIdx + 1) : track;

  const index = buildPlanIndex(planCoords);
  const dist = ida.map((p) => index.distanceM(p.lat, p.lng));
  const desvioMaxM = Math.round(Math.max(...dist));

  // Tramos fuera de ruta: rachas seguidas de puntos a mas de OFF_M.
  let kmFuera = 0;
  const rachas = [];
  let cur = null;
  for (let i = 1; i < ida.length; i += 1) {
    const seg = haversineM(ida[i - 1], ida[i]) / 1000;
    const off = dist[i] > T.OFF_M && dist[i - 1] > T.OFF_M;
    if (off) {
      kmFuera += seg;
      if (!cur) cur = { desdeIdx: i - 1, km: 0, maxM: 0 };
      cur.km += seg;
      cur.maxM = Math.max(cur.maxM, dist[i], dist[i - 1]);
      cur.hastaIdx = i;
    } else if (cur) {
      rachas.push(cur);
      cur = null;
    }
  }
  if (cur) rachas.push(cur);
  const tramosFuera = rachas
    .filter((r) => r.km >= T.TRAMO_MIN_KM)
    .map((r) => ({
      desde: new Date(ida[r.desdeIdx].at).toISOString(),
      hasta: new Date(ida[r.hastaIdx].at).toISOString(),
      minutos: Math.round((ida[r.hastaIdx].at - ida[r.desdeIdx].at) / 60000),
      km: Math.round(r.km * 10) / 10,
      maxM: Math.round(r.maxM),
      inicio: { lat: round5(ida[r.desdeIdx].lat), lng: round5(ida[r.desdeIdx].lng) },
      fin: { lat: round5(ida[r.hastaIdx].lat), lng: round5(ida[r.hastaIdx].lng) },
    }))
    .sort((a, b) => b.km - a.km)
    .slice(0, 6);

  const kmReal = trackLengthKm(ida);
  const extraKm = kmPlan != null ? kmReal - kmPlan : null;

  // Area C: minutos adentro (cada intervalo entre dos puntos seguidos adentro cuenta, con tope de 10 min por si el GPS se corto).
  let areaC = null;
  if (areaCPath?.length) {
    let ms = 0;
    let entradas = 0;
    let adentro = false;
    const flags = ida.map((p) => pointInPolygon({ lat: p.lat, lng: p.lng }, areaCPath));
    for (let i = 0; i < ida.length; i += 1) {
      if (flags[i] && !adentro) entradas += 1;
      adentro = flags[i];
      if (i > 0 && flags[i] && flags[i - 1]) ms += Math.min(10 * 60 * 1000, ida[i].at - ida[i - 1].at);
    }
    areaC = { entradas, minutos: Math.round(ms / 60000) };
  }

  const resumen = {
    llego,
    puntos: track.length,
    desde: new Date(track[0].at).toISOString(),
    hasta: new Date(track.at(-1).at).toISOString(),
    kmReal: Math.round(kmReal * 10) / 10,
    kmPlan: kmPlan != null ? Math.round(kmPlan * 10) / 10 : null,
    extraKm: extraKm != null ? Math.round(extraKm * 10) / 10 : null,
    desvioMaxM,
    fueraDeRutaPct: kmReal > 0 ? Math.round((kmFuera / kmReal) * 1000) / 10 : 0,
    tramosFuera,
    areaC,
  };
  return { resumen, linea: simplifyTrack(track), ida };
};

// Motivos por los que conviene revisar el recorrido, y el estado ("OK" / "REVISAR"). "info" solo se muestra; "revisar" marca el servicio.
export const evaluateReasons = (resumen, { peajesNoPrevistos = [], areaCPrevista = false } = {}) => {
  const T = THRESHOLDS;
  const motivos = [];
  const grande = resumen.tramosFuera.find((t) => t.km >= T.TRAMO_REVISAR_KM || t.minutos >= T.TRAMO_REVISAR_MIN);
  if (grande) {
    motivos.push({
      nivel: "revisar",
      codigo: "TRAMO_FUERA",
      texto: `Salió de la ruta planificada durante ${grande.km} km (${grande.minutos} min), hasta ${grande.maxM >= 1000 ? `${(grande.maxM / 1000).toFixed(1)} km` : `${grande.maxM} m`} de distancia del plan.`,
    });
  }
  if (resumen.extraKm != null && resumen.llego && resumen.extraKm >= Math.max(T.EXTRA_KM_REVISAR, (resumen.kmPlan ?? 0) * T.EXTRA_PCT_REVISAR)) {
    motivos.push({ nivel: "revisar", codigo: "KM_EXTRA", texto: `Hizo ${resumen.extraKm} km más que la ruta planificada (${resumen.kmReal} km reales contra ${resumen.kmPlan} km).` });
  }
  if (resumen.areaC?.minutos > 0 && !areaCPrevista) {
    motivos.push({ nivel: "revisar", codigo: "AREA_C", texto: `Estuvo ${resumen.areaC.minutos} min dentro del Área C, que la ruta planificada no cruzaba.` });
  }
  if (peajesNoPrevistos.length) {
    motivos.push({ nivel: "info", codigo: "PEAJES", texto: `Pasó por peajes que el plan no incluía: ${peajesNoPrevistos.join(", ")}.` });
  }
  if (!resumen.llego) {
    motivos.push({ nivel: "info", codigo: "SIN_LLEGADA", texto: "El GPS no llegó a registrar la entrega en la última parada (puede ser un corte de señal)." });
  }
  return { estado: motivos.some((m) => m.nivel === "revisar") ? "REVISAR" : "OK", motivos };
};
