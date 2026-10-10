import { findDriverServicesForEstilo } from "../models/meta.model.js";
import { findRecordById, updateRecordById } from "../models/record.model.js";
import { aggregateEstilo } from "../utils/drivingStyle.js";
import { AppError } from "../utils/AppError.js";
import { findOnesystecVehicleIdByPlate, getVehicleDrivingStyle, isOnesystecConfigured } from "./onesystec.service.js";

const MIN_MS = 60000;
const DAY_MS = 24 * 60 * MIN_MS;
const DAYS = 30;
// Un servicio recien terminado todavia puede recibir reportes del GPS atrasados: se espera un rato.
const SETTLE_MS = 15 * MIN_MS;
const RETRY_AFTER_FAILURE_MS = 30 * MIN_MS;
const MAX_ENQUEUE_PER_CALL = 25;
const MAX_QUEUE = 300;

// Guarda en el servicio lo que importa de la respuesta de OneSystec (no toda).
const toStored = (body, from, to) => ({
  desde: new Date(from).toISOString(),
  hasta: new Date(to).toISOString(),
  km: typeof body?.distanceKm === "number" ? body.distanceKm : 0,
  calidad: body?.quality ?? "no_data",
  incidentes: body?.incidents ?? null,
  puntosPorIncidente: body?.rules?.pointsPerIncidentPer100Km ?? null,
  minKm: body?.rules?.minDistanceKm ?? null,
});

// Calcula (y guarda) el estilo de manejo del vehiculo SOLO durante la jornada declarada de un servicio.
// Lanza si el GPS no responde o no conoce el vehiculo: el servicio queda pendiente y se reintenta mas tarde.
export const computeEstiloForRecord = async (recordId) => {
  if (!isOnesystecConfigured()) throw new AppError("La conexion con el GPS no esta configurada", 503);
  const record = await findRecordById(recordId);
  if (!record?.horaInicioReal || !record.horaFinReal || !record.vehicle?.targa) return null;

  const from = record.horaInicioReal.getTime();
  const to = record.horaFinReal.getTime();
  // Jornada imposible (fin antes del inicio o mas de 31 dias): se marca sin datos para no insistir.
  if (to <= from || to - from > 31 * DAY_MS) {
    const stored = { desde: null, hasta: null, km: 0, calidad: "no_data", incidentes: null };
    await updateRecordById(record.id, { estiloManejo: stored, estiloCalculadoAt: new Date() });
    return stored;
  }

  const onesystecId = await findOnesystecVehicleIdByPlate(record.vehicle.targa);
  if (!onesystecId) throw new AppError(`El vehiculo ${record.vehicle.targa} no esta en el GPS`, 404);
  const stored = toStored(await getVehicleDrivingStyle(onesystecId, from, to), from, to);
  await updateRecordById(record.id, { estiloManejo: stored, estiloCalculadoAt: new Date() });
  return stored;
};

// Cola de un servicio a la vez (OneSystec limita las peticiones por minuto) y sin esperar a nadie: se llama al
// enviar o ajustar las horas, y al abrir el dashboard para los servicios que aun no tienen su puntaje.
const queue = [];
const queued = new Set();
const computing = new Set();
const lastFailureAt = new Map();
let running = false;

const pump = async () => {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift();
      queued.delete(id);
      computing.add(id);
      try {
        await computeEstiloForRecord(id);
        lastFailureAt.delete(id);
      } catch (err) {
        lastFailureAt.set(id, Date.now());
        console.error(`[estilo] no se pudo calcular el del servicio ${id}:`, err.message);
      } finally {
        computing.delete(id);
      }
    }
  } finally {
    running = false;
  }
};

export const refreshEstiloInBackground = (recordId, { force = false } = {}) => {
  if (!isOnesystecConfigured() || queued.has(recordId) || computing.has(recordId) || queue.length >= MAX_QUEUE) return;
  if (!force && Date.now() - (lastFailureAt.get(recordId) ?? 0) < RETRY_AFTER_FAILURE_MS) return;
  queued.add(recordId);
  queue.push(recordId);
  void pump();
};

// Estilo de manejo de quien consulta: suma los incidentes y km de SUS servicios de los ultimos 30 dias (solo el
// tramo que manejo, aunque el vehiculo lo usen otros choferes) y aplica la formula de OneSystec. Los servicios
// que aun no tienen su dato se calculan en segundo plano; mientras tanto se usa lo que ya hay.
// Devuelve null si no hay GPS configurado ni servicios con jornada; es solo informativo.
export const getMyDrivingStyle = async (actor) => {
  if (!isOnesystecConfigured()) return null;
  const services = await findDriverServicesForEstilo({ driverId: actor.id, from: new Date(Date.now() - DAYS * DAY_MS) });

  const ready = [];
  let pendientes = 0;
  for (const s of services) {
    if (s.estiloCalculadoAt && s.estiloManejo) {
      ready.push(s.estiloManejo);
    } else if (s.horaFinReal && s.horaFinReal.getTime() <= Date.now() - SETTLE_MS) {
      pendientes += 1;
      if (pendientes <= MAX_ENQUEUE_PER_CALL) refreshEstiloInBackground(s.id);
    }
  }

  const result = aggregateEstilo(ready);
  if (!result) return pendientes > 0 ? { puntaje: null, calculando: true, dias: DAYS, servicios: 0, pendientes } : null;
  return { puntaje: result.puntaje, categorias: result.categorias, dias: DAYS, servicios: ready.length, pendientes };
};
