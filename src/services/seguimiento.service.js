import { env } from "../config/env.js";
import { AREA_LABELS } from "../constants/areas.js";
import { defaultSalidaFor } from "../constants/salidaPorDefecto.js";
import { findRespaldoPings } from "../models/gpsRespaldo.model.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { findActiveForSeguimiento, findGroupMembers, markLlegadaGps } from "../models/seguimiento.model.js";
import { findOfficeUserIdsForArea, findUserLocationById } from "../models/user.model.js";
import { canAccessAreaKey, recordAreaKey, recordAreaWhere } from "../utils/areaAccess.js";
import { deriveSpeeds, distanceMeters } from "../utils/stopDetection.js";
import { findOnesystecVehicleIdByPlate, getVehiclePositions, isOnesystecConfigured } from "./onesystec.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { calculateRoute } from "./routing.service.js";
import { getFreshVehiclePositionByTarga } from "./velocityFleet.service.js";

// Seguimiento en vivo de los servicios en camino. La posicion sale, por orden, del GPS del vehiculo (Velocity Fleet y, si ese
// no lo tiene, OneSystec), del GPS del celular del chofer (respaldo, solo si lo autorizo) o, si no hay ninguno, de un recorrido
// simulado sobre la ruta planificada: asi el servicio no desaparece del mapa, pero queda marcado "sin GPS" y se avisa a la
// oficina. Cuando el vehiculo llega a la parada final de un servicio (a menos de 150 m y casi parado) se guarda la hora real de
// llegada y ese servicio deja de contar como pendiente (sin ETA ni avisos).
const ACTIVE_ESTADOS = ["IN_CONSEGNA", "RITIRATO"];
const DONE_ESTADOS = ["CONSEGNATO", "ANNULLATO", "RISCHEDULATO"];
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const WINDOW_BEFORE_MS = 36 * HOUR_MS;
const WINDOW_AFTER_MS = 12 * HOUR_MS;
const LIVE_TTL_MS = 45 * 1000;
const PHONE_FRESH_MS = 10 * MIN_MS;
// OneSystec manda un punto cada pocos segundos en marcha y hasta cada hora quieto: una posicion en marcha vieja de mas de 20 min
// es una senal perdida; una quieta puede tener hasta 70 min y seguir siendo la ultima ubicacion real.
const ONESYSTEC_MOVING_FRESH_MS = 20 * MIN_MS;
const ONESYSTEC_PARKED_FRESH_MS = 70 * MIN_MS;
const FIRST_SCAN_MAX_MS = 6 * HOUR_MS;
const ARRIVAL_RADIUS_M = 150;
// Casi parado (la unidad depende de la cuenta del GPS: km/h o mph): una pasada a velocidad normal no cuenta como llegada.
const ARRIVAL_MAX_SPEED = 15;
// Un servicio que ya llego sigue en la lista este rato (para ver "llego a las HH:MM") y despues sale.
const ARRIVAL_KEEP_MS = 20 * MIN_MS;
// Si la parada final esta casi en el punto de salida no se puede distinguir salir de llegar.
const ARRIVAL_MIN_FROM_ORIGIN_M = 400;
// Cuanto puede pasar la llegada estimada sobre la ETA antes de avisar.
export const RETRASO_AVISO_MIN = 5;
// Cuanto tiempo sin ningun GPS antes de avisar (para no alarmar por un dato que tarda en llegar).
const SIN_GPS_AVISO_MS = 3 * MIN_MS;
const ALERTS_KEY = "seguimiento.alertas";

export const TIPOS_SEGUIMIENTO = Object.fromEntries(Object.entries(AREA_LABELS));

const hasCoords = (p) => p?.lat != null && p?.lng != null;
const lastPlacedStop = (member) => member.stops.filter(hasCoords).at(-1) ?? null;

// ---- posicion -------------------------------------------------------------------------------------------------

// Hasta que instante se miro el historial de cada viaje y cual fue el ultimo punto: cada pasada solo pide lo nuevo.
const scanState = new Map();

const gpsFromSample = (fuente, sample) => ({
  fuente,
  lat: sample.lat,
  lng: sample.lng,
  actualizada: sample.at ? new Date(sample.at).toISOString() : null,
  velocidad: sample.speed ?? null,
  motor: sample.ignition ?? null,
  rumbo: sample.direction ?? null,
});

const phoneTrack = async (driverId, fromMs, now) => {
  const pings = deriveSpeeds(await findRespaldoPings(driverId, new Date(fromMs), new Date(now)));
  const last = pings.at(-1);
  if (last && now - last.at.getTime() <= PHONE_FRESH_MS) return { fuente: "CELULAR", samples: pings, last };
  if (env.PHONE_LOCATION_ENABLED) {
    const phone = await findUserLocationById(driverId);
    if (phone?.ubicacionLat != null && phone.ubicacionActualizada && now - phone.ubicacionActualizada.getTime() <= PHONE_FRESH_MS) {
      const sample = { at: phone.ubicacionActualizada, lat: phone.ubicacionLat, lng: phone.ubicacionLng, speed: null };
      return { fuente: "CELULAR", samples: [sample], last: sample };
    }
  }
  return null;
};

// Posicion del vehiculo y puntos nuevos desde la ultima vez (para detectar llegadas): GPS del vehiculo de Velocity Fleet; si ese
// no lo tiene, el historial de OneSystec; y si tampoco, el celular del chofer. null = ningun GPS.
const loadTrack = async (group, pendientes, now) => {
  const [first] = group.members;
  const targa = first.vehicle?.targa;
  const state = scanState.get(group.key);
  const earliest = Math.min(...pendientes.map((m) => new Date(m.fechaRetiro ?? m.fechaServicio).getTime()));
  const fromMs = state ? state.to - 2 * MIN_MS : Math.max(earliest - 30 * MIN_MS, now - FIRST_SCAN_MAX_MS);
  const remember = (track) => {
    scanState.set(group.key, { to: now, last: track.last });
    return track;
  };

  const live = await getFreshVehiclePositionByTarga(targa);
  if (live) {
    const sample = { at: live.updatedAt ?? new Date(now), lat: live.lat, lng: live.lng, speed: live.speed, ignition: live.ignition, direction: live.direction };
    return remember({ fuente: "VEHICULO", samples: state?.last ? [state.last, sample] : [sample], last: sample });
  }

  if (isOnesystecConfigured() && targa) {
    try {
      const vehicleId = await findOnesystecVehicleIdByPlate(targa);
      if (vehicleId) {
        let rows = await getVehiclePositions(vehicleId, fromMs, now);
        // Quieto, el GPS casi no manda puntos: sin ninguno nuevo se mira un rato atras para saber donde esta.
        if (!rows.length && !state?.last) rows = await getVehiclePositions(vehicleId, now - 75 * MIN_MS, now);
        const last = rows.at(-1) ?? state?.last;
        if (last) {
          const age = now - new Date(last.at).getTime();
          const moving = last.moving === true || last.ignition === true || (last.speed ?? 0) > 3;
          if (age <= (moving ? ONESYSTEC_MOVING_FRESH_MS : ONESYSTEC_PARKED_FRESH_MS)) {
            return remember({ fuente: "VEHICULO", samples: rows, last });
          }
        }
      }
    } catch {
      // Sin historial (cuenta caida o vehiculo que no esta ahi): se sigue con el celular.
    }
  }

  const phone = await phoneTrack(first.driverId, fromMs, now);
  return phone ? remember(phone) : null;
};

// ---- llegada a la parada ---------------------------------------------------------------------------------------

// Primera vez, desde afterMs, que el vehiculo estuvo a menos de 150 m de la parada y casi parado (null si no).
export const firstArrival = (samples, stop, afterMs) => {
  for (const sample of samples) {
    const at = new Date(sample.at).getTime();
    if (at < afterMs) continue;
    if (distanceMeters(stop, sample) > ARRIVAL_RADIUS_M) continue;
    if (sample.speed != null && sample.speed > ARRIVAL_MAX_SPEED) continue;
    return new Date(at);
  }
  return null;
};

const salidaOf = (record) =>
  hasCoords({ lat: record.salidaLat, lng: record.salidaLng })
    ? { lat: record.salidaLat, lng: record.salidaLng, direccion: record.salidaDireccion }
    : defaultSalidaFor(record);

// Marca la llegada de los servicios cuyo destino ya visito el vehiculo. Cada llegada tiene que ser posterior a la anterior.
const detectArrivals = async (pendientes, samples) => {
  let after = 0;
  for (const member of pendientes) {
    const stop = lastPlacedStop(member);
    if (!stop) continue;
    const salida = salidaOf(member);
    if (hasCoords(salida) && distanceMeters(stop, salida) < ARRIVAL_MIN_FROM_ORIGIN_M) continue;
    const floor = Math.max(after, new Date(member.fechaRetiro ?? member.fechaServicio).getTime() - 30 * MIN_MS);
    const at = firstArrival(samples, stop, floor);
    if (!at) continue;
    after = at.getTime();
    member.llegadaGpsAt = at;
    await markLlegadaGps(member.id, at).catch(() => {});
  }
};

// ---- calculo por viaje -----------------------------------------------------------------------------------------

const pointAlong = (coordinates, fraction) => {
  if (!coordinates?.length) return null;
  if (coordinates.length === 1 || fraction <= 0) return { lat: coordinates[0][1], lng: coordinates[0][0] };
  const segments = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const length = distanceMeters(
      { lat: coordinates[i - 1][1], lng: coordinates[i - 1][0] },
      { lat: coordinates[i][1], lng: coordinates[i][0] }
    );
    segments.push(length);
    total += length;
  }
  let remaining = Math.min(1, fraction) * total;
  for (let i = 0; i < segments.length; i += 1) {
    if (remaining <= segments[i] || i === segments.length - 1) {
      const t = segments[i] > 0 ? Math.min(1, remaining / segments[i]) : 0;
      const [lng0, lat0] = coordinates[i];
      const [lng1, lat1] = coordinates[i + 1];
      return { lat: lat0 + (lat1 - lat0) * t, lng: lng0 + (lng1 - lng0) * t };
    }
    remaining -= segments[i];
  }
  const last = coordinates[coordinates.length - 1];
  return { lat: last[1], lng: last[0] };
};

const liveCache = new Map();
// A que viaje (clave de liveCache) y area pertenece cada servicio visto en el ultimo listado: la ruta se pide con el id.
const serviceIndex = new Map();
const planCache = new Map();
const PLAN_CACHE_MAX = 200;

const planFirma = (points) => points.map((p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`).join("|");

// Ruta planificada (salida -> paradas del viaje): no cambia mientras el viaje no cambie, por eso se guarda.
const planRoute = async (points) => {
  const key = planFirma(points);
  if (planCache.has(key)) return planCache.get(key);
  const route = await calculateRoute(points);
  if (planCache.size >= PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value);
  if (route) planCache.set(key, route);
  return route;
};

// Cada servicio pendiente del viaje aporta sus paradas con ubicacion, en el orden del viaje. "ultima" marca la parada
// final del servicio: ahi es donde se mide su llegada.
const buildPoints = (pendientes) => {
  const points = [];
  pendientes.forEach((member) => {
    const placed = member.stops.filter(hasCoords);
    placed.forEach((stop, index) => {
      points.push({
        lat: stop.lat,
        lng: stop.lng,
        direccion: stop.direccion,
        recordId: member.id,
        ultima: index === placed.length - 1,
      });
    });
  });
  return points;
};

// Llegada (minutos desde ahora) a la parada final de cada servicio, sumando el trayecto de cada tramo y el tiempo que se
// queda en cada parada.
const cumulativeMinutes = (tramos, points) => {
  const factor = env.ESTIMATE_TRAFFIC_FACTOR;
  const dwell = env.ESTIMATE_STOP_MIN;
  const byRecord = new Map();
  let t = 0;
  points.forEach((point, index) => {
    t += (tramos[index]?.duracionMin ?? 0) * factor;
    if (point.ultima) byRecord.set(point.recordId, t);
    t += dwell;
  });
  return byRecord;
};

const isPending = (member) => !DONE_ESTADOS.includes(member.estado) && !member.llegadaGpsAt;

const computeGroup = async (group, now) => {
  const cached = liveCache.get(group.key);
  if (cached && now - cached.at < LIVE_TTL_MS) return cached.data;

  const [first] = group.members;
  const driver = first.driver;
  const targa = first.vehicle?.targa;
  let pendientes = group.members.filter(isPending);

  let track = null;
  if (pendientes.length) {
    track = await loadTrack(group, pendientes, now);
    if (track) {
      await detectArrivals(pendientes, track.samples);
      pendientes = group.members.filter(isPending);
    }
  }

  const points = buildPoints(pendientes);
  let gps = track ? gpsFromSample(track.fuente, track.last) : null;
  let geometriaRestante = null;
  let geometriaPlan = null;
  const arrivals = new Map();

  if (track && points.length) {
    const route = await calculateRoute([{ lat: track.last.lat, lng: track.last.lng }, ...points]);
    if (route) {
      geometriaRestante = route.geometria;
      cumulativeMinutes(route.tramos, points).forEach((minutes, recordId) => arrivals.set(recordId, now + minutes * MIN_MS));
    }
  } else if (!track && points.length) {
    // Sin ningun GPS: recorrido simulado sobre la ruta planificada, segun la hora de salida y la ETA del ultimo servicio.
    const salida = salidaOf(pendientes[0]);
    const route = hasCoords(salida) ? await planRoute([{ lat: salida.lat, lng: salida.lng }, ...points]) : null;
    if (route) {
      geometriaPlan = route.geometria;
      const factor = env.ESTIMATE_TRAFFIC_FACTOR;
      const total = route.tramos.reduce((sum, leg) => sum + leg.duracionMin * factor, 0) + env.ESTIMATE_STOP_MIN * Math.max(0, points.length - 1);
      const lastEta = new Date(pendientes[pendientes.length - 1].eta).getTime();
      const departure = pendientes[0].fechaRetiro ? new Date(pendientes[0].fechaRetiro).getTime() : lastEta - total * MIN_MS;
      const span = Math.max(MIN_MS, lastEta - departure);
      // No llega al final mientras el servicio siga abierto: se queda cerca del destino.
      const fraction = Math.min(0.97, Math.max(0, (now - departure) / span));
      const simulated = pointAlong(route.geometria.coordinates, fraction);
      if (simulated) gps = { fuente: "SIMULADO", lat: simulated.lat, lng: simulated.lng, actualizada: null };
    }
  }

  const data = { gps, points, arrivals, geometriaRestante, geometriaPlan, targa, driver, hayPendientes: pendientes.length > 0 };
  liveCache.set(group.key, { at: now, data });
  return data;
};

// ---- listado ---------------------------------------------------------------------------------------------------

const buildGroups = (active, extraMembers) => {
  const byGroupKey = new Map();
  active.forEach((record) => {
    const key = record.compactadoId ?? record.id;
    if (!byGroupKey.has(key)) byGroupKey.set(key, { key, compactadoId: record.compactadoId, members: [] });
    if (!record.compactadoId) byGroupKey.get(key).members.push(record);
  });
  extraMembers.forEach((record) => byGroupKey.get(record.compactadoId)?.members.push(record));
  byGroupKey.forEach((group) => group.members.sort((a, b) => (a.compactadoOrden ?? 0) - (b.compactadoOrden ?? 0)));
  return [...byGroupKey.values()].filter((group) => group.members.length);
};

// Linea de tiempo del viaje: para cada servicio, entregado, llego (hora real del GPS) o la llegada estimada. Cuando no hay
// posicion para calcular el trayecto, la demora de un servicio corre la de los que le siguen.
const timelineOf = (group, data, now) => {
  let carry = 0;
  return group.members.map((member) => {
    const etaMs = new Date(member.eta).getTime();
    const hecho = DONE_ESTADOS.includes(member.estado);
    const llegoAt = member.llegadaGpsAt ? new Date(member.llegadaGpsAt) : null;
    let llegada = null;
    if (!hecho && !llegoAt) {
      const arrival = data.arrivals.get(member.id);
      if (arrival != null) llegada = arrival;
      else {
        llegada = Math.max(etaMs + carry, now);
        carry = llegada - etaMs;
      }
    }
    return {
      id: member.id,
      codigo: member.codigo,
      orden: member.compactadoOrden ?? 1,
      cliente: member.client?.nombre ?? null,
      destino: member.stops.at(-1)?.direccion ?? member.destinazione,
      estado: member.estado,
      entregado: hecho,
      llego: Boolean(llegoAt),
      llegoAt: llegoAt ? llegoAt.toISOString() : null,
      puntualidadMin: llegoAt ? Math.round((llegoAt.getTime() - etaMs) / MIN_MS) : null,
      etaPlan: member.eta.toISOString(),
      llegadaEstimada: llegada ? new Date(llegada).toISOString() : null,
      retrasoMin: llegada ? Math.round((llegada - etaMs) / MIN_MS) : 0,
    };
  });
};

export const getSeguimiento = async (actor, { now = Date.now() } = {}) => {
  const active = await findActiveForSeguimiento({
    estados: ACTIVE_ESTADOS,
    gte: new Date(now - WINDOW_BEFORE_MS),
    lte: new Date(now + WINDOW_AFTER_MS),
    areaWhere: recordAreaWhere(actor),
  });
  liveCache.forEach((entry, key) => {
    if (now - entry.at > 10 * MIN_MS) {
      liveCache.delete(key);
      scanState.delete(key);
    }
  });
  serviceIndex.forEach((value, id) => {
    if (!liveCache.has(value.key)) serviceIndex.delete(id);
  });
  const compactadoIds = [...new Set(active.map((r) => r.compactadoId).filter(Boolean))];
  const groups = buildGroups(active, await findGroupMembers(compactadoIds));

  const servicios = [];
  for (const group of groups) {
    const data = await computeGroup(group, now);
    const timeline = timelineOf(group, data, now);
    const compact = group.members.length > 1;
    group.members.forEach((member, index) => {
      if (DONE_ESTADOS.includes(member.estado)) return;
      const item = timeline[index];
      // Ya llego hace un rato: sale de la lista (sigue en la linea de tiempo de su viaje).
      if (item.llego && now - new Date(item.llegoAt).getTime() > ARRIVAL_KEEP_MS) return;
      const areaKey = recordAreaKey(member);
      serviceIndex.set(member.id, { key: group.key, areaKey });
      servicios.push({
        id: member.id,
        codigo: member.codigo,
        grupoId: group.compactadoId,
        orden: member.compactadoOrden ?? 1,
        totalViaje: compact ? group.members.length : 1,
        tipo: areaKey,
        tipoLabel: TIPOS_SEGUIMIENTO[areaKey],
        estado: member.estado,
        chofer: { id: data.driver.id, nombre: `${data.driver.nombre} ${data.driver.apellido}`.trim(), telefono: data.driver.numeroCelular ?? null },
        vehiculo: data.targa ?? null,
        cliente: member.client?.nombre ?? null,
        destino: item.destino,
        etaPlan: item.etaPlan,
        llego: item.llego,
        llegoAt: item.llegoAt,
        puntualidadMin: item.puntualidadMin,
        llegadaEstimada: item.llegadaEstimada,
        minutosRestantes: item.llegadaEstimada ? Math.max(0, Math.round((new Date(item.llegadaEstimada).getTime() - now) / MIN_MS)) : null,
        retrasoMin: item.retrasoMin,
        gps: data.gps ? { ...data.gps } : null,
        // Sin GPS solo importa mientras al viaje le quede algo por llegar.
        sinGps: data.hayPendientes && !item.llego && (!data.gps || data.gps.fuente === "SIMULADO"),
        timeline: compact ? timeline : null,
      });
    });
  }

  servicios.sort((a, b) => new Date(a.etaPlan) - new Date(b.etaPlan));
  return { servicios, generadoAt: new Date(now).toISOString() };
};

// Ruta del servicio elegido (para dibujarla en el mapa): lo que falta desde la posicion actual, o la planificada si no hay GPS.
export const getRutaSeguimiento = async (actor, id, { now = Date.now() } = {}) => {
  let indexed = serviceIndex.get(id);
  let cached = indexed && liveCache.get(indexed.key)?.data;
  if (!cached) {
    // Sin listado reciente (servidor reiniciado o viaje ya vencido del cache): se arma una vez.
    await getSeguimiento(actor, { now });
    indexed = serviceIndex.get(id);
    cached = indexed && liveCache.get(indexed.key)?.data;
  }
  if (!cached || !canAccessAreaKey(actor, indexed.areaKey)) return null;
  return {
    geometria: cached.geometriaRestante ?? cached.geometriaPlan ?? null,
    simulada: !cached.geometriaRestante,
    paradas: cached.points.map((p) => ({ lat: p.lat, lng: p.lng, direccion: p.direccion, recordId: p.recordId, ultima: p.ultima })),
  };
};

// ---- alertas ---------------------------------------------------------------------------------------------------

const groupServices = (servicios) => {
  const groups = new Map();
  servicios.forEach((s) => {
    const key = s.grupoId ?? s.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  groups.forEach((items) => items.sort((a, b) => a.orden - b.orden));
  return groups;
};

const lateOf = (items) => items.filter((s) => !s.llego && s.retrasoMin > RETRASO_AVISO_MIN);

// Un solo aviso por viaje: el primer servicio que llega tarde y, de una vez, los que le siguen y tambien se atrasan, para
// poder llamar a esos clientes a tiempo.
const retrasoTexto = (late, { paraChofer = false } = {}) => {
  const [first, ...rest] = late;
  if (!rest.length) {
    return paraChofer
      ? `${first.codigo} supera su ETA por ${first.retrasoMin} min. Avisa a la oficina si necesitas mas tiempo.`
      : `${first.codigo} llegara con ~${first.retrasoMin} min de retraso sobre su ETA. Alarga la ETA si hace falta.`;
  }
  const afectados = rest.map((s) => `${s.codigo}${!paraChofer && s.cliente ? ` (${s.cliente})` : ""} +${s.retrasoMin} min`).join(", ");
  return paraChofer
    ? `${first.codigo} supera su ETA por ${first.retrasoMin} min y eso atrasa tambien ${afectados}. Avisa a la oficina.`
    : `${first.codigo} llegara con ~${first.retrasoMin} min de retraso sobre su ETA. Tambien se atrasan: ${afectados}. Avisa a esos clientes y alarga las ETA si hace falta.`;
};

// Alertas de lo que esta pasando ahora, para la campanita: viaje sin ningun GPS y viaje fuera de ETA.
export const buildSeguimientoAlerts = (servicios) => {
  const alerts = [];
  groupServices(servicios).forEach((items, groupKey) => {
    const sinGps = items.find((s) => s.sinGps);
    if (sinGps) {
      alerts.push({
        id: `seguimiento-sin-gps-${groupKey}`,
        kind: "SIN_GPS",
        severity: "urgent",
        recordId: sinGps.id,
        message: `${sinGps.chofer.nombre} (${sinGps.vehiculo ?? "sin vehiculo"}) no tiene GPS activo en ${sinGps.codigo}. Llamalo ahora.`,
      });
    }
    const late = lateOf(items);
    if (late.length) {
      alerts.push({
        id: `seguimiento-retraso-${groupKey}`,
        kind: "RETRASO",
        severity: "warning",
        recordId: late[0].id,
        message: retrasoTexto(late),
      });
    }
  });
  return alerts;
};

let processing = null;

// Manda las notificaciones push: una sola vez por cada situacion (el estado ya avisado se guarda, asi sobrevive a un reinicio).
const processAlerts = async (servicios, now) => {
  const saved = (await getConfig(ALERTS_KEY))?.valor ?? {};
  const next = {};
  const sends = [];

  groupServices(servicios).forEach((items, groupKey) => {
    const [head] = items;
    const areaKey = head.tipo;

    const sinGps = items.find((s) => s.sinGps);
    if (sinGps) {
      const prev = saved[`gps:${groupKey}`] ?? {};
      const desde = prev.desde ?? now;
      const avisado = prev.avisado ?? false;
      next[`gps:${groupKey}`] = { desde, avisado };
      if (!avisado && now - desde >= SIN_GPS_AVISO_MS) {
        next[`gps:${groupKey}`].avisado = true;
        sends.push(async () => {
          const office = await findOfficeUserIdsForArea(areaKey);
          await sendPushToUserIds(office, {
            title: "Servicio sin GPS: llama al chofer",
            body: `${sinGps.chofer.nombre} (${sinGps.vehiculo ?? "sin vehiculo"}) no tiene GPS activo en ${sinGps.codigo}. Llamalo ahora.`,
            data: { type: "seguimiento", recordId: sinGps.id, alerta: "sin-gps" },
          });
          await sendPushToUserIds([sinGps.chofer.id], {
            title: "Activa tu GPS",
            body: "No recibimos tu ubicacion en el servicio. Abre la app y activa el GPS de respaldo en Mi perfil.",
            data: { type: "gps-respaldo" },
          });
        });
      }
    }

    const late = lateOf(items);
    if (late.length) {
      // Una vez por situacion: si la oficina alarga una ETA o se atrasa otro servicio del viaje, se avisa de nuevo.
      const signature = late.map((s) => `${s.id}:${s.etaPlan}`).join("|");
      if (saved[`eta:${groupKey}`] !== signature) {
        sends.push(async () => {
          const office = await findOfficeUserIdsForArea(areaKey);
          await sendPushToUserIds(office, {
            title: late.length > 1 ? "Viaje atrasado: avisa a los clientes" : "Servicio fuera de su ETA",
            body: `${head.chofer.nombre}: ${retrasoTexto(late)}`,
            data: { type: "seguimiento", recordId: late[0].id, alerta: "retraso" },
          });
          await sendPushToUserIds([head.chofer.id], {
            title: "Tu servicio supera su ETA",
            body: retrasoTexto(late, { paraChofer: true }),
            data: { type: "seguimiento", recordId: late[0].id, alerta: "retraso" },
          });
        });
      }
      next[`eta:${groupKey}`] = signature;
    }
  });

  if (JSON.stringify(next) !== JSON.stringify(saved)) await setConfig(ALERTS_KEY, next);
  await Promise.allSettled(sends.map((send) => send()));
};

// Calcula y avisa para TODOS los servicios (sin filtro de area): lo corre el temporizador y, de paso, cada consulta de la
// oficina. Nunca se pisa a si mismo: si ya hay una pasada en curso se espera esa.
export const runSeguimientoAlerts = async (now = Date.now()) => {
  if (processing) return processing;
  processing = (async () => {
    try {
      const { servicios } = await getSeguimiento({ cargo: "OWNER" }, { now });
      await processAlerts(servicios, now);
      return servicios;
    } catch (err) {
      console.error("[seguimiento] no se pudieron procesar las alertas:", err.message);
      return [];
    } finally {
      processing = null;
    }
  })();
  return processing;
};

export const getSeguimientoForActor = async (actor) => {
  const result = await getSeguimiento(actor);
  // Sin esperar: la respuesta no depende de que salgan los avisos.
  runSeguimientoAlerts().catch(() => {});
  return { ...result, alertas: buildSeguimientoAlerts(result.servicios) };
};
