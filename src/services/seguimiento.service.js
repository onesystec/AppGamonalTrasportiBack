import { env } from "../config/env.js";
import { AREA_LABELS } from "../constants/areas.js";
import { defaultSalidaFor } from "../constants/salidaPorDefecto.js";
import { findLastRespaldoPing } from "../models/gpsRespaldo.model.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { findActiveForSeguimiento, findGroupMembers } from "../models/seguimiento.model.js";
import { findOfficeUserIdsForArea, findUserLocationById } from "../models/user.model.js";
import { canAccessAreaKey, recordAreaKey, recordAreaWhere } from "../utils/areaAccess.js";
import { distanceMeters } from "../utils/stopDetection.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { calculateRoute } from "./routing.service.js";
import { getFreshVehiclePositionByTarga } from "./velocityFleet.service.js";

// Seguimiento en vivo de los servicios en camino. La posicion sale, por orden, del GPS del vehiculo, del GPS del
// celular del chofer (respaldo, solo si lo autorizo) o, si no hay ninguno, de un recorrido simulado sobre la ruta
// planificada: asi el servicio no desaparece del mapa, pero queda marcado "sin GPS" y se avisa a la oficina.
const ACTIVE_ESTADOS = ["IN_CONSEGNA", "RITIRATO"];
const DONE_ESTADOS = ["CONSEGNATO", "ANNULLATO", "RISCHEDULATO"];
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const WINDOW_BEFORE_MS = 36 * HOUR_MS;
const WINDOW_AFTER_MS = 12 * HOUR_MS;
const LIVE_TTL_MS = 45 * 1000;
const PHONE_FRESH_MS = 10 * MIN_MS;
// Cuanto puede pasar la llegada estimada sobre la ETA antes de avisar.
export const RETRASO_AVISO_MIN = 5;
// Cuanto tiempo sin ningun GPS antes de avisar (para no alarmar por un dato que tarda en llegar).
const SIN_GPS_AVISO_MS = 3 * MIN_MS;
const ALERTS_KEY = "seguimiento.alertas";

export const TIPOS_SEGUIMIENTO = Object.fromEntries(Object.entries(AREA_LABELS));

const round1 = (value) => Math.round(value * 10) / 10;
const hasCoords = (p) => p?.lat != null && p?.lng != null;

// ---- posicion -------------------------------------------------------------------------------------------------

const resolvePosition = async (driverId, targa) => {
  const vehicle = await getFreshVehiclePositionByTarga(targa);
  if (vehicle) {
    return {
      fuente: "VEHICULO",
      lat: vehicle.lat,
      lng: vehicle.lng,
      actualizada: vehicle.updatedAt?.toISOString?.() ?? null,
      velocidad: vehicle.speed ?? null,
      unidadVelocidad: vehicle.speedUnit ?? null,
      motor: vehicle.ignition ?? null,
      rumbo: vehicle.direction ?? null,
    };
  }

  const ping = await findLastRespaldoPing(driverId);
  if (ping && Date.now() - ping.recordedAt.getTime() <= PHONE_FRESH_MS) {
    return { fuente: "CELULAR", lat: ping.lat, lng: ping.lng, actualizada: ping.recordedAt.toISOString() };
  }
  if (env.PHONE_LOCATION_ENABLED) {
    const phone = await findUserLocationById(driverId);
    if (phone?.ubicacionLat != null && phone.ubicacionActualizada && Date.now() - phone.ubicacionActualizada.getTime() <= PHONE_FRESH_MS) {
      return {
        fuente: "CELULAR",
        lat: phone.ubicacionLat,
        lng: phone.ubicacionLng,
        actualizada: phone.ubicacionActualizada.toISOString(),
      };
    }
  }
  return null;
};

// Punto a una fraccion (0-1) de la distancia total de una linea (GeoJSON LineString).
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

// ---- calculo por viaje -----------------------------------------------------------------------------------------

const salidaOf = (record) =>
  hasCoords({ lat: record.salidaLat, lng: record.salidaLng })
    ? { lat: record.salidaLat, lng: record.salidaLng, direccion: record.salidaDireccion }
    : defaultSalidaFor(record);

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

const computeGroup = async (group, now) => {
  const [first] = group.members;
  const driver = first.driver;
  const targa = first.vehicle?.targa;
  const pendientes = group.members.filter((m) => !DONE_ESTADOS.includes(m.estado));
  const points = buildPoints(pendientes);
  const cached = liveCache.get(group.key);
  if (cached && now - cached.at < LIVE_TTL_MS) return cached.data;

  const position = await resolvePosition(driver.id, targa);
  let gps = position;
  let geometriaRestante = null;
  let geometriaPlan = null;
  const arrivals = new Map();

  if (position && points.length) {
    const route = await calculateRoute([{ lat: position.lat, lng: position.lng }, ...points]);
    if (route) {
      geometriaRestante = route.geometria;
      cumulativeMinutes(route.tramos, points).forEach((minutes, recordId) => arrivals.set(recordId, now + minutes * MIN_MS));
    }
  } else if (!position && points.length) {
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

  const data = { gps, points, arrivals, geometriaRestante, geometriaPlan, targa, driver };
  liveCache.set(group.key, { at: now, data });
  return data;
};

// ---- listado ---------------------------------------------------------------------------------------------------

const buildGroups = (active, extraMembers) => {
  const byGroup = new Map();
  active.forEach((record) => {
    const key = record.compactadoId ?? record.id;
    if (!byGroup.has(key)) byGroup.set(key, { key, compactadoId: record.compactadoId, members: [] });
    if (!record.compactadoId) byGroup.get(key).members.push(record);
  });
  extraMembers.forEach((record) => byGroup.get(record.compactadoId)?.members.push(record));
  byGroup.forEach((group) =>
    group.members.sort((a, b) => (a.compactadoOrden ?? 0) - (b.compactadoOrden ?? 0))
  );
  return [...byGroup.values()].filter((group) => group.members.length);
};

const timelineOf = (group, data, now) =>
  group.members.map((member) => {
    const hecho = DONE_ESTADOS.includes(member.estado);
    const arrival = data.arrivals.get(member.id);
    const llegada = hecho ? null : arrival ?? Math.max(new Date(member.eta).getTime(), now);
    return {
      id: member.id,
      codigo: member.codigo,
      orden: member.compactadoOrden ?? 1,
      cliente: member.client?.nombre ?? null,
      destino: member.stops.at(-1)?.direccion ?? member.destinazione,
      estado: member.estado,
      entregado: hecho,
      etaPlan: member.eta.toISOString(),
      llegadaEstimada: llegada ? new Date(llegada).toISOString() : null,
      retrasoMin: llegada ? Math.round((llegada - new Date(member.eta).getTime()) / MIN_MS) : 0,
    };
  });

export const getSeguimiento = async (actor, { now = Date.now() } = {}) => {
  const active = await findActiveForSeguimiento({
    estados: ACTIVE_ESTADOS,
    gte: new Date(now - WINDOW_BEFORE_MS),
    lte: new Date(now + WINDOW_AFTER_MS),
    areaWhere: recordAreaWhere(actor),
  });
  liveCache.forEach((entry, key) => {
    if (now - entry.at > 10 * MIN_MS) liveCache.delete(key);
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
        llegadaEstimada: item.llegadaEstimada,
        minutosRestantes: item.llegadaEstimada ? Math.max(0, Math.round((new Date(item.llegadaEstimada).getTime() - now) / MIN_MS)) : null,
        retrasoMin: item.retrasoMin,
        gps: data.gps ? { ...data.gps } : null,
        sinGps: !data.gps || data.gps.fuente === "SIMULADO",
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

// Alertas de lo que esta pasando ahora, para la campanita: servicio sin ningun GPS y servicio fuera de ETA.
export const buildSeguimientoAlerts = (servicios) => {
  const alerts = [];
  const seenGroups = new Set();
  servicios.forEach((s) => {
    const groupKey = s.grupoId ?? s.id;
    if (s.sinGps && !seenGroups.has(groupKey)) {
      seenGroups.add(groupKey);
      alerts.push({
        id: `seguimiento-sin-gps-${groupKey}`,
        kind: "SIN_GPS",
        severity: "urgent",
        recordId: s.id,
        message: `${s.chofer.nombre} (${s.vehiculo ?? "sin vehiculo"}) no tiene GPS activo en ${s.codigo}. Llamalo ahora.`,
      });
    }
    if (s.retrasoMin > RETRASO_AVISO_MIN) {
      alerts.push({
        id: `seguimiento-retraso-${s.id}`,
        kind: "RETRASO",
        severity: "warning",
        recordId: s.id,
        message: `${s.codigo} (${s.chofer.nombre}) supera su ETA por ${s.retrasoMin} min. Alarga la ETA si hace falta.`,
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
  const seenGroups = new Set();

  for (const s of servicios) {
    const groupKey = s.grupoId ?? s.id;
    const areaKey = s.tipo;

    if (s.sinGps && !seenGroups.has(groupKey)) {
      seenGroups.add(groupKey);
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
            body: `${s.chofer.nombre} (${s.vehiculo ?? "sin vehiculo"}) no tiene GPS activo en ${s.codigo}. Llamalo ahora.`,
            data: { type: "seguimiento", recordId: s.id, alerta: "sin-gps" },
          });
          await sendPushToUserIds([s.chofer.id], {
            title: "Activa tu GPS",
            body: "No recibimos tu ubicacion en el servicio. Abre la app y activa el GPS de respaldo en Mi perfil.",
            data: { type: "gps-respaldo" },
          });
        });
      }
    }

    if (s.retrasoMin > RETRASO_AVISO_MIN) {
      const prev = saved[`eta:${s.id}`];
      // Una vez por ETA: si la oficina la alarga y vuelve a pasarse, se avisa de nuevo.
      if (prev !== s.etaPlan) {
        sends.push(async () => {
          const office = await findOfficeUserIdsForArea(areaKey);
          await sendPushToUserIds(office, {
            title: "Servicio fuera de su ETA",
            body: `${s.codigo} (${s.chofer.nombre}) supera su ETA por ${s.retrasoMin} min. Alarga la ETA si hace falta.`,
            data: { type: "seguimiento", recordId: s.id, alerta: "retraso" },
          });
          await sendPushToUserIds([s.chofer.id], {
            title: "Tu servicio supera su ETA",
            body: `${s.codigo} lleva ${s.retrasoMin} min sobre la hora prevista. Avisa a la oficina si necesitas mas tiempo.`,
            data: { type: "seguimiento", recordId: s.id, alerta: "retraso" },
          });
        });
      }
      next[`eta:${s.id}`] = s.etaPlan;
    }
  }

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
