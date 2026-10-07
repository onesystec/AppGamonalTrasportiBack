// Deteccion de paradas a partir de posiciones GPS muestreadas cada pocos minutos. Es pura (sin
// red ni base) para poder probarla con secuencias de posiciones inventadas.

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

// Distancia en metros entre dos puntos {lat, lng} (haversine).
export const distanceMeters = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
};

// Por debajo de esta velocidad el vehiculo se considera quieto. La unidad depende de la cuenta
// de Velocity Fleet (km/h o mph): 3 es "casi parado" en cualquiera de las dos.
const STILL_SPEED = 3;

// Estado inicial de seguimiento de un vehiculo a partir de su primera muestra.
export const newTrack = (sample) => ({
  anchor: { lat: sample.lat, lng: sample.lng },
  since: sample.at,
  lastStationaryAt: sample.at,
  motorApagado: sample.ignition === false,
  openStopId: null,
});

// Procesa una muestra {lat, lng, speed, ignition, at(Date)} y devuelve que paso:
//  - "quieto": sigue detenido (con "abrir: true" cuando ya paso el minimo y hay que registrar la parada)
//  - "movimiento": se movio; si habia una parada abierta, "cerrar" trae sus datos finales
// No muta "track": devuelve el nuevo estado en "track".
export const advanceTrack = (track, sample, { radiusM, minMinutes }) => {
  const moved = distanceMeters(track.anchor, sample) > radiusM;
  // Quieto si la velocidad es casi cero o si el propio GPS dice que no hay movimiento (sample.moving).
  const slow = sample.speed == null || sample.speed <= STILL_SPEED || sample.moving === false;

  if (!moved && slow) {
    const next = {
      ...track,
      lastStationaryAt: sample.at,
      motorApagado: track.motorApagado || sample.ignition === false,
    };
    const minutes = (sample.at.getTime() - track.since.getTime()) / 60000;
    return { kind: "quieto", track: next, abrir: !track.openStopId && minutes >= minMinutes };
  }

  const close = track.openStopId
    ? {
        stopId: track.openStopId,
        endedAt: track.lastStationaryAt,
        motorApagado: track.motorApagado,
        durationMin: Math.max(0, Math.round((track.lastStationaryAt.getTime() - track.since.getTime()) / 60000)),
      }
    : null;
  return { kind: "movimiento", track: newTrack(sample), cerrar: close };
};

// Clase de una parada ya terminada (o en curso, para mostrarla), por prioridad:
// servicio (es trabajo) > combustible > tolerada > a revisar.
export const classifyStop = ({ durationMin, nearestServiceM, fuelMatch, serviceRadiusM, toleranceMin }) => {
  if (nearestServiceM != null && nearestServiceM <= serviceRadiusM) {
    return { clase: "SERVICIO", motivo: `A ${Math.round(nearestServiceM)} m de una parada del servicio o del deposito` };
  }
  if (fuelMatch) return { clase: "COMBUSTIBLE", motivo: "Coincide con una carga de combustible" };
  if (durationMin <= toleranceMin) return { clase: "TOLERADA", motivo: `Hasta ${toleranceMin} min se considera normal` };
  return { clase: "A_REVISAR", motivo: "Parada larga lejos de las paradas del servicio" };
};

// Paradas dentro de una secuencia de posiciones ordenada por hora (historial). Devuelve
// [{ startedAt, endedAt, lat, lng, durationMin, motorApagado }] de las paradas de al menos
// minMinutes. "ultimoLatidoMs": cuando el vehiculo esta quieto el GPS manda un punto cada hasta ~60
// min; si la secuencia termina con el vehiculo quieto, la parada se extiende hasta windowEnd siempre
// que el hueco sea menor que ese tiempo (sigue parado), si no termina en el ultimo punto.
export const detectStops = (samples, { radiusM, minMinutes, windowEnd, heartbeatMs = 65 * 60000 }) => {
  const stops = [];
  let track = null;
  let current = null; // parada abierta { startedAt, ... }

  const finish = (endedAt) => {
    if (!current) return;
    const durationMin = Math.round((endedAt.getTime() - current.startedAt.getTime()) / 60000);
    if (durationMin >= minMinutes) {
      stops.push({ ...current, endedAt, durationMin, motorApagado: track.motorApagado });
    }
    current = null;
  };

  for (const sample of samples) {
    if (!track) {
      track = newTrack(sample);
      continue;
    }
    const step = advanceTrack(track, sample, { radiusM, minMinutes: 0 });
    if (step.kind === "movimiento") {
      if (current) finish(track.lastStationaryAt);
      track = step.track;
      continue;
    }
    // quieto
    if (!current && step.abrir) {
      current = { startedAt: track.since, lat: track.anchor.lat, lng: track.anchor.lng };
    }
    track = step.track;
  }

  if (current && track) {
    const gap = windowEnd ? windowEnd.getTime() - track.lastStationaryAt.getTime() : Infinity;
    finish(windowEnd && gap <= heartbeatMs ? windowEnd : track.lastStationaryAt);
  }
  return stops;
};

// Ultimo instante en que el vehiculo se estaba moviendo (velocidad por encima de "casi parado") dentro
// de una secuencia de posiciones, o null. Es el momento en que "dejo de moverse" al final.
export const lastMovementAt = (samples, fromMs = 0) => {
  let last = null;
  for (const sample of samples) {
    if (sample.at.getTime() >= fromMs && sample.speed != null && sample.speed > STILL_SPEED) last = sample.at;
  }
  return last;
};

// Ultima vez que el vehiculo estuvo a menos de radiusM de alguno de los puntos (las paradas del
// servicio) entre dos instantes: { at, point } o null.
export const lastNearPoint = (samples, points, radiusM, { fromMs, toMs }) => {
  let best = null;
  for (const sample of samples) {
    const t = sample.at.getTime();
    if (t < fromMs || t > toMs) continue;
    for (const point of points) {
      if (distanceMeters(point, sample) <= radiusM) {
        best = { at: sample.at, point };
        break;
      }
    }
  }
  return best;
};

// Estimacion de respaldo del tiempo de viaje entre dos puntos (minutos) cuando el servicio de rutas
// no responde: distancia en linea recta x 1.35 a 45 km/h de promedio.
export const estimateDriveMinutes = (a, b) => Math.round(((distanceMeters(a, b) * 1.35) / 1000 / 45) * 60);
