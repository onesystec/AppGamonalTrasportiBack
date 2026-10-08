import { DEPOT_ORIGIN } from "../constants/depot.js";
import { WORK_PLACES } from "../constants/workPlaces.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import {
  createParadas,
  deleteParadasByRecord,
  findFuelNear,
  findParadas,
  findParadasByRecordIds,
  findVehicleRecordsAround,
  groupParadasByClase,
} from "../models/parada.model.js";
import { findRespaldoPings } from "../models/gpsRespaldo.model.js";
import { findRecordById, updateRecordById } from "../models/record.model.js";
import { AppError } from "../utils/AppError.js";
import {
  classifyStop,
  deriveSpeeds,
  detectStops,
  distanceMeters,
  estimateDriveMinutes,
  lastMovementAt,
  lastNearPoint,
} from "../utils/stopDetection.js";
import { calculateRoute } from "./routing.service.js";
import { computeEstimacionForRecord } from "./rutaEstimada.service.js";
import { findOnesystecVehicleIdByPlate, getVehiclePositions, isOnesystecConfigured } from "./onesystec.service.js";

const MIN_MS = 60000;
const DAY_MS = 24 * 60 * MIN_MS;
// El GPS manda un punto cada hasta ~60 min cuando el vehiculo esta quieto: se pide un rato antes del
// inicio para saber donde estaba parado al empezar la jornada.
const LOOKBACK_MS = 65 * MIN_MS;
// Para saber si el vehiculo siguio circulando despues del fin declarado se mira un rato mas alla
// (solo se guarda CUANDO dejo de moverse, nunca donde estuvo despues del fin).
const AFTER_END_MS = env.STOP_TAIL_MINUTES * MIN_MS;
// Cerca de una parada del propio servicio = estaba entregando ahi.
const DELIVERY_RADIUS_M = 300;

// Si el GPS del vehiculo no tiene puntos en los ultimos 90 min de la jornada se considera que no la cubre
// (cuando esta quieto manda un punto cada hasta ~60 min).
const VEHICLE_GAP_MS = 90 * MIN_MS;

// Posiciones para calcular las paradas de un servicio. Primero el GPS del vehiculo (OneSystec); si esta
// bloqueado, caido o no cubre toda la jornada, se completan con los puntos del celular del chofer (solo los
// guardados mientras el respaldo estaba activo). "fuente" dice de donde salieron: VEHICULO, CELULAR o MIXTO.
const loadSamples = async (record, fromMs, toMs) => {
  let vehicle = [];
  let providerError = null;
  if (isOnesystecConfigured()) {
    try {
      const onesystecId = await findOnesystecVehicleIdByPlate(record.vehicle.targa);
      if (!onesystecId) providerError = new AppError(`El vehiculo ${record.vehicle.targa} no esta en el GPS`, 404);
      else vehicle = await getVehiclePositions(onesystecId, fromMs, toMs);
    } catch (err) {
      providerError = err;
    }
  } else {
    providerError = new AppError("La conexion con el GPS no esta configurada", 503);
  }

  const lastVehicleMs = vehicle.length ? vehicle[vehicle.length - 1].at.getTime() : null;
  const coversEnd = lastVehicleMs != null && lastVehicleMs >= Math.min(toMs, Date.now()) - VEHICLE_GAP_MS;
  if (coversEnd) return { samples: vehicle, fuente: "VEHICULO" };

  if (env.GPS_RESPALDO_ENABLED && record.driverId) {
    const phone = deriveSpeeds(await findRespaldoPings(record.driverId, new Date(fromMs), new Date(toMs)));
    if (phone.length >= 2) {
      if (lastVehicleMs == null) return { samples: phone, fuente: "CELULAR" };
      const tail = phone.filter((p) => p.at.getTime() > lastVehicleMs);
      if (tail.length) return { samples: [...vehicle, ...tail], fuente: "MIXTO" };
    }
  }
  if (vehicle.length) return { samples: vehicle, fuente: "VEHICULO" };
  throw providerError ?? new AppError("El GPS no tiene datos de ese tramo", 404);
};

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

// Punto de trabajo mas cercano a una parada: paradas de los servicios del vehiculo, el deposito y
// los lugares de trabajo (constants/workPlaces.js y WORK_PLACES). Cada lugar tiene su radio (radioM)
// o, si no, el general; "enTrabajo" = la parada cae dentro del radio del lugar mas cercano.
const nearestWorkPlace = (point, recordsAround) => {
  let best = null;
  const consider = (place, name) => {
    const meters = distanceMeters(point, place);
    const radius = place.radioM ?? env.STOP_SERVICE_RADIUS_METERS;
    // Se compara por cuanto falta para entrar en el radio, no por la distancia a secas.
    const margin = meters - radius;
    if (best == null || margin < best.margin) {
      best = { meters, name, margin, enTrabajo: margin <= 0, esParqueo: place.tipo === "parqueo" };
    }
  };
  consider(DEPOT_ORIGIN, "el deposito");
  for (const place of [...WORK_PLACES, ...env.WORK_PLACES]) consider(place, place.nombre ?? "un lugar de trabajo");
  for (const record of recordsAround) for (const stop of record.stops) consider(stop, "una parada del servicio");
  return best;
};

// Lectura del GPS sobre el final de la jornada:
//  - cuando el vehiculo dejo de moverse por ultima vez (y si seguia circulando al terminar la ventana);
//  - si el chofer termino sin pasar por el lugar de espera (por ejemplo fue a casa), la regla C: se
//    paga hasta que llega, con un tope igual a lo que habria tardado en volver al lugar de espera desde
//    su ultima entrega. Tope = hora en que dejo la ultima parada del servicio + tiempo de vuelta.
// Solo se guardan horas y duraciones, nunca ubicaciones de despues del fin de la jornada.
const analyzeJornadaEnd = async ({ record, allSamples, from, declaredFin, analysisEnd, salidaAt }) => {
  const windowEnd = Math.min(analysisEnd, Date.now());
  const moved = lastMovementAt(allSamples, from.getTime());
  const out = {
    // Cuando el vehiculo salio, si empezo la jornada parado fuera de un lugar de trabajo.
    salidaAt: salidaAt ? salidaAt.toISOString() : null,
    ultimoMovimientoAt: moved ? moved.toISOString() : null,
    // Sigue en movimiento al final de lo que se pudo mirar (o los datos llegan hasta ahora mismo).
    continuaMoviendo: Boolean(moved) && windowEnd - moved.getTime() <= 5 * MIN_MS && windowEnd >= declaredFin.getTime() + AFTER_END_MS - 5 * MIN_MS,
    datosParciales: analysisEnd > Date.now(),
    calculadoAt: new Date().toISOString(),
    ultimaEntregaAt: null,
    base: null,
    vueltaMin: null,
    vueltaFuente: null,
    topeFinAt: null,
  };

  if (!record.finFueraDeBase) return out;

  const ownStops = (record.stops ?? []).filter((s) => s.lat != null && s.lng != null);
  const delivery = lastNearPoint(allSamples, ownStops, DELIVERY_RADIUS_M, {
    fromMs: from.getTime(),
    toMs: declaredFin.getTime(),
  });
  if (!delivery) return out;

  // A que lugar de espera habria vuelto: el mas cercano a la ultima entrega.
  const bases = [
    { ...DEPOT_ORIGIN, nombre: "el deposito" },
    ...WORK_PLACES,
    ...env.WORK_PLACES,
  ];
  let base = null;
  for (const candidate of bases) {
    const meters = distanceMeters(delivery.point, candidate);
    if (!base || meters < base.meters) base = { ...candidate, meters };
  }

  const route = await calculateRoute([delivery.point, base]);
  const vueltaMin = route ? Math.round(route.duracionMin) : estimateDriveMinutes(delivery.point, base);

  out.ultimaEntregaAt = delivery.at.toISOString();
  out.base = base.nombre ?? "el lugar de espera";
  out.vueltaMin = vueltaMin;
  out.vueltaFuente = route ? "ruta" : "estimada";
  out.topeFinAt = new Date(delivery.at.getTime() + vueltaMin * MIN_MS).toISOString();
  return out;
};

// Calcula (y guarda) las paradas del vehiculo entre el inicio y el fin declarados de la jornada de
// un servicio. Reemplaza las que hubiera de antes para ese servicio. Solo mira ese tramo: lo que el
// vehiculo hace fuera de la jornada no se consulta ni se guarda.
export const computeParadasForRecord = async (recordId) => {
  if (!isOnesystecConfigured() && !env.GPS_RESPALDO_ENABLED) {
    throw new AppError("La conexion con el GPS no esta configurada", 503);
  }

  const record = await findRecordById(recordId);
  if (!record) throw new AppError("Registro no encontrado", 404);
  if (!record.horaInicioReal || !record.horaFinReal) {
    throw new AppError("El servicio no tiene inicio y fin de jornada cargados", 409);
  }

  const from = record.horaInicioReal;
  const to = record.horaFinReal;

  // El fin que se compara con el GPS es el que declaro el chofer, no el que la oficina haya ajustado.
  const declaredFin = new Date(record.horasDeclaradas?.fin ?? record.horaFinReal);
  const analysisEnd = Math.max(to.getTime(), declaredFin.getTime()) + AFTER_END_MS;
  const { samples: allSamples, fuente } = await loadSamples(record, from.getTime() - LOOKBACK_MS, analysisEnd);
  const samples = allSamples.filter((s) => s.at.getTime() <= to.getTime());
  const rawStops = detectStops(samples, {
    radiusM: env.STOP_RADIUS_METERS,
    minMinutes: 1,
    windowEnd: to,
  });

  // Se recorta a la jornada y se descartan las que no alcanzan el minimo.
  const stops = rawStops
    .map((s) => {
      const startedAt = new Date(Math.max(s.startedAt.getTime(), from.getTime()));
      const endedAt = new Date(Math.min(s.endedAt.getTime(), to.getTime()));
      return {
        ...s,
        startedAt,
        endedAt,
        // Ya estaba parado cuando empezo la jornada (por ejemplo durmio ahi): no es una pausa de la
        // jornada sino el tiempo hasta que salio.
        startsBeforeWindow: s.startedAt.getTime() <= from.getTime(),
        durationMin: Math.round((endedAt - startedAt) / MIN_MS),
      };
    })
    .filter((s) => s.endedAt > s.startedAt && s.durationMin >= env.STOP_MIN_MINUTES);

  const around = await findVehicleRecordsAround({
    vehicleId: record.vehicleId,
    from: new Date(from.getTime() - 12 * 60 * MIN_MS),
    to: new Date(to.getTime() + 12 * 60 * MIN_MS),
  });

  const rows = [];
  let salidaAt = null;
  for (const stop of stops) {
    const place = nearestWorkPlace(stop, around);
    const inWork = place?.enTrabajo === true;
    // Parado al empezar la jornada fuera de los lugares de trabajo o en el parqueo (los vehiculos duermen en
    // casa de los choferes o en el parqueo): no es una parada a revisar, es la salida del vehiculo, que se
    // compara con el inicio declarado. Si nunca llego a salir en toda la jornada, no hay salida.
    if (stop.startsBeforeWindow && (!inWork || place.esParqueo)) {
      if (stop.endedAt.getTime() < to.getTime() - MIN_MS) salidaAt = stop.endedAt;
      continue;
    }
    // Solo se consulta la base si la parada ya no es trabajo ni tolerable: es el unico caso donde el
    // combustible cambia el resultado.
    let fuelMatch = false;
    if (!inWork && stop.durationMin > env.STOP_TOLERANCE_MINUTES) {
      fuelMatch = Boolean(
        await findFuelNear({
          vehicleId: record.vehicleId,
          targa: record.vehicle.targa,
          from: new Date(stop.startedAt.getTime() - 30 * MIN_MS),
          to: new Date(stop.endedAt.getTime() + 30 * MIN_MS),
        })
      );
    }
    const { clase, motivo } = classifyStop({
      durationMin: stop.durationMin,
      // Si cae en un lugar de trabajo (con su radio) se le pasa distancia 0 al clasificador.
      nearestServiceM: place ? (place.enTrabajo ? 0 : place.meters) : null,
      fuelMatch,
      serviceRadiusM: 0,
      toleranceMin: env.STOP_TOLERANCE_MINUTES,
    });
    rows.push({
      vehicleId: record.vehicleId,
      targa: record.vehicle.targa,
      driverId: record.driverId,
      recordId: record.id,
      startedAt: stop.startedAt,
      endedAt: stop.endedAt,
      durationMin: stop.durationMin,
      lat: stop.lat,
      lng: stop.lng,
      motorApagado: stop.motorApagado,
      clase,
      motivo: clase === "SERVICIO" && place ? `Cerca de ${place.name} (${Math.round(place.meters)} m)` : motivo,
      distanciaServicioM: place ? Math.round(place.meters) : null,
      fuente,
    });
  }

  const gpsFin = { ...(await analyzeJornadaEnd({ record, allSamples, from, declaredFin, analysisEnd, salidaAt })), fuente };

  await deleteParadasByRecord(record.id);
  if (rows.length > 0) await createParadas(rows);
  await updateRecordById(record.id, { paradasCalculadasAt: new Date(), gpsFin });
  return rows;
};

// Mismo calculo pero sin esperar y sin romper a quien lo llama (envio de horas, aprobacion). Si el
// GPS falla, el servicio queda "sin calcular" y se puede reintentar a mano. Un servicio a la vez.
const inFlight = new Set();
// Si una consulta falla (GPS caido, vehiculo que no esta en el GPS), no se reintenta sola durante un rato:
// abrir la cola de aprobacion varias veces no tiene que repetir consultas que van a volver a fallar.
const RETRY_AFTER_FAILURE_MS = 30 * MIN_MS;
const lastFailureAt = new Map();
export const refreshParadasInBackground = (recordId) => {
  if (inFlight.has(recordId)) return;
  if (Date.now() - (lastFailureAt.get(recordId) ?? 0) < RETRY_AFTER_FAILURE_MS) return;
  inFlight.add(recordId);
  computeParadasForRecord(recordId)
    .then(() => lastFailureAt.delete(recordId))
    .catch((err) => {
      lastFailureAt.set(recordId, Date.now());
      console.error(`[paradas] no se pudieron calcular las del servicio ${recordId}:`, err.message);
      // Sin GPS (ni del vehiculo ni del celular): queda al menos la estimacion por ruta.
      return computeEstimacionForRecord(recordId).catch(() => {});
    })
    .finally(() => inFlight.delete(recordId));
};

// Paradas ya calculadas de varios servicios, agrupadas por servicio, para la pantalla de aprobacion.
export const loadParadasForRecords = async (recordIds) => {
  const byRecord = new Map(recordIds.map((id) => [id, []]));
  if (recordIds.length === 0) return byRecord;
  const rows = await findParadasByRecordIds(recordIds);
  for (const row of rows) byRecord.get(row.recordId)?.push(toParadaItem(row));
  return byRecord;
};

export const toParadaItem = (i) => ({
  id: i.id,
  inicio: i.startedAt,
  fin: i.endedAt,
  duracionMin: i.durationMin,
  lat: i.lat,
  lng: i.lng,
  motorApagado: i.motorApagado,
  clase: i.clase,
  motivo: i.motivo,
  distanciaServicioM: i.distanciaServicioM,
  fuente: i.fuente ?? "VEHICULO",
});

// ---------------------------------------------------------------- consulta (solo OWNER/ADMIN)

export const getParadasStatus = () => ({
  configurado: isOnesystecConfigured(),
  respaldoCelular: env.GPS_RESPALDO_ENABLED,
  toleranciaMin: env.STOP_TOLERANCE_MINUTES,
  minimoMin: env.STOP_MIN_MINUTES,
  radioServicioM: env.STOP_SERVICE_RADIUS_METERS,
  lugaresDeTrabajo: WORK_PLACES.length + env.WORK_PLACES.length,
});

export const listParadasForActor = async (actor, query) => {
  if (!isPrivileged(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);

  const toDay = query.to ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
  const fromDay =
    query.from ?? new Date(Date.now() - 6 * DAY_MS).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
  // Un dia de margen a cada lado, el filtro fino por dia de Roma se hace en el frontend.
  const from = new Date(new Date(`${fromDay}T00:00:00Z`).getTime() - DAY_MS);
  const to = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 2 * DAY_MS);

  const [items, groups] = await Promise.all([
    findParadas({
      from,
      to,
      clases: query.clase,
      vehicleId: query.vehicleId,
      driverId: query.driverId,
      recordId: query.recordId,
      limit: 500,
    }),
    groupParadasByClase({ from, to }),
  ]);

  const driverIds = [...new Set(items.map((i) => i.driverId).filter(Boolean))];
  const recordIds = [...new Set(items.map((i) => i.recordId).filter(Boolean))];
  const [drivers, records] = await Promise.all([
    driverIds.length
      ? prisma.user.findMany({ where: { id: { in: driverIds } }, select: { id: true, nombre: true, apellido: true } })
      : [],
    recordIds.length ? prisma.record.findMany({ where: { id: { in: recordIds } }, select: { id: true, codigo: true } }) : [],
  ]);
  const driverName = new Map(drivers.map((d) => [d.id, `${d.nombre} ${d.apellido}`]));
  const recordCode = new Map(records.map((r) => [r.id, r.codigo]));

  return {
    desde: fromDay,
    hasta: toDay,
    resumen: groups.map((g) => ({ clase: g.clase, cantidad: g._count._all, minutos: g._sum.durationMin ?? 0 })),
    items: items.map((i) => ({
      ...toParadaItem(i),
      targa: i.targa,
      chofer: i.driverId ? (driverName.get(i.driverId) ?? null) : null,
      driverId: i.driverId,
      codigo: i.recordId ? (recordCode.get(i.recordId) ?? null) : null,
      recordId: i.recordId,
    })),
  };
};
