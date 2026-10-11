import { findAllPeajes } from "../models/peaje.model.js";

// Catalogo de peajes de Italia (ver scripts/import-peajes-osm.mjs). Son ~700 filas que casi no cambian: se leen una vez y quedan en
// memoria (se refrescan cada hora por si se reimporta).
const TTL_MS = 60 * 60 * 1000;
let cache = null;
let cachedAt = 0;

export const listPeajes = async () => {
  if (!cache || Date.now() - cachedAt > TTL_MS) {
    cache = await findAllPeajes();
    cachedAt = Date.now();
  }
  return cache;
};

// Distancia (m) de un punto a un segmento, en un plano local (suficiente para decidir si una ruta pasa a menos de ~100 m).
const segmentDistanceM = (p, a, b) => {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const px = p.lng * k * 111320;
  const py = p.lat * 110540;
  const ax = a[0] * k * 111320;
  const ay = a[1] * 110540;
  const bx = b[0] * k * 111320;
  const by = b[1] * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Peajes por los que pasa una ruta (GeoJSON LineString): los que quedan a menos de radiusM de alguno de sus tramos, en el orden en
// que se cruzan. Es lo que se pinta en el mapa y lo que sirve para comprobar que una ruta "sin peaje" realmente no pasa por ninguno.
export const peajesEnRuta = async (geometria, { radiusM = 70 } = {}) => {
  const coords = geometria?.coordinates;
  if (!coords || coords.length < 2) return [];
  const peajes = await listPeajes();
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const pad = 0.002;
  const [minLng, maxLng, minLat, maxLat] = [Math.min(...lngs) - pad, Math.max(...lngs) + pad, Math.min(...lats) - pad, Math.max(...lats) + pad];
  const found = [];
  for (const peaje of peajes) {
    if (peaje.lng < minLng || peaje.lng > maxLng || peaje.lat < minLat || peaje.lat > maxLat) continue;
    for (let i = 1; i < coords.length; i += 1) {
      if (segmentDistanceM(peaje, coords[i - 1], coords[i]) <= radiusM) {
        found.push({ ...peaje, orden: i });
        break;
      }
    }
  }
  return found.sort((a, b) => a.orden - b.orden).map(({ orden, ...peaje }) => peaje);
};

export const peajeLabel = (peaje) => peaje.nombre ?? (peaje.tipo === "PORTALE" ? "Portico free-flow" : "Peaje sin nombre");

const sameOperator = (a, b) => !a.operador || !b.operador || a.operador === b.operador;

// Cuantos pagos son los peajes por los que pasa una ruta (en el orden en que se cruzan). En una autopista cerrada se toma ticket al
// entrar y se paga al salir: dos casetas = un pago. Por eso se juntan de a dos casetas seguidas de la misma concesionaria
// (entrada -> salida). Un portico free-flow es un pago por si solo, y una caseta que queda sin pareja se marca como "barrera unica"
// (sistema abierto, o la otra caseta no esta en el catalogo): hay que revisarla. Es una estimacion: OpenStreetMap no dice que
// autopista es cerrada y cual abierta.
export const agruparPagos = (peajes) => {
  const pagos = [];
  for (let i = 0; i < peajes.length; i += 1) {
    const actual = peajes[i];
    const siguiente = peajes[i + 1];
    if (actual.tipo === "PORTALE") {
      pagos.push({ tipo: "FREE_FLOW", desde: peajeLabel(actual), hasta: null, operador: actual.operador ?? null });
    } else if (siguiente && siguiente.tipo !== "PORTALE" && sameOperator(actual, siguiente)) {
      pagos.push({
        tipo: "ENTRADA_SALIDA",
        desde: peajeLabel(actual),
        hasta: peajeLabel(siguiente),
        operador: actual.operador ?? siguiente.operador ?? null,
      });
      i += 1;
    } else {
      pagos.push({ tipo: "BARRERA_UNICA", desde: peajeLabel(actual), hasta: null, operador: actual.operador ?? null });
    }
  }
  return pagos;
};

export const pagoTexto = (pago) => (pago.hasta ? `${pago.desde} → ${pago.hasta}` : pago.desde);
