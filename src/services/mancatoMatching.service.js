import {
  findAssignableMancatos,
  findCandidateServices,
  findVehiclesWithAssignableMancatos,
  updateMancatoAssignment,
} from "../models/mancato.model.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Pasar por el peaje un rato antes de la hora de retiro cargada sigue siendo de ese servicio.
const TOLERANCIA_ANTES_MS = 45 * MIN;
// Si el servicio no tiene duracion de ruta, se supone esto para la ida (y para la vuelta).
const RUTA_POR_DEFECTO_MS = 2 * HOUR;
// Ventana de busqueda de servicios alrededor del transito.
const BUSQUEDA_ATRAS_MS = 5 * DAY;
const BUSQUEDA_ADELANTE_MS = 1 * DAY;
// Solo se re-evaluan los mancatos recientes.
const REEVALUAR_DESDE_MS = 90 * DAY;

const hoursText = (ms) => {
  const hours = Math.round((Math.abs(ms) / HOUR) * 10) / 10;
  return `${String(hours).replace(".", ",")} h`;
};

// Linea de tiempo de un servicio para su vehiculo:
//   start      cuando sale (Fecha retiro; si no la tiene, se estima y queda marcado "inferido")
//   idaEnd     hasta cuando se esperaria que siga yendo (la ETA es un maximo de entrega, asi que
//              se recorta con la duracion real de la ruta); despues de esto se considera vuelta
//   returnEnd  hasta cuando se esperaria que siga volviendo
// Entre start y returnEnd el vehiculo "pertenece" a este servicio.
export const serviceWindow = (service) => {
  const rutaMs = service.rutaDuracionMin > 0 ? service.rutaDuracionMin * MIN : null;
  const eta = service.eta ? new Date(service.eta).getTime() : null;

  let start;
  let inferido = false;
  if (service.fechaRetiro) {
    start = new Date(service.fechaRetiro).getTime();
  } else {
    inferido = true;
    const received = new Date(service.fechaServicio).getTime();
    start = eta && rutaMs ? Math.max(received, eta - rutaMs) : received;
  }

  let idaEnd = start + (rutaMs ? rutaMs * 1.3 + 30 * MIN : RUTA_POR_DEFECTO_MS);
  if (eta && eta > start) idaEnd = Math.min(idaEnd, eta);
  idaEnd = Math.max(idaEnd, start + 30 * MIN);

  const returnEnd = idaEnd + Math.max((rutaMs ?? RUTA_POR_DEFECTO_MS) * 1.5 + 30 * MIN, 3 * HOUR);
  return { start, idaEnd, returnEnd, inferido };
};

// Tramo (ida / vuelta) que le corresponderia a un peaje dentro de un servicio dado.
export const tramoForService = (service, transitAt) =>
  tramoAt(serviceWindow(service), new Date(transitAt).getTime());

const tramoAt = (window, transitMs) => (transitMs <= window.idaEnd ? "IDA" : "VUELTA");

const enEspera = (asignacionMotivo) => ({
  recordId: null,
  asignacion: "EN_ESPERA",
  tramo: null,
  asignacionMotivo,
});

// Decide a que servicio pertenece un peaje. Reglas (ver tambien la explicacion en el PR):
//  1. Solo cuentan los servicios del mismo vehiculo que ya habian empezado (con una pequena
//     tolerancia) y cuya ventana "ida + vuelta" todavia no habia terminado.
//  2. Si hay uno solo, es ese. Si hay varios, gana el del mismo chofer, luego el que estaba
//     en la ida, luego el que empezo mas tarde: el vehiculo "ya paso" al siguiente servicio.
//  3. Se asigna solo (AUTO) si no hay dudas; si las hay, queda SUGERIDO para que la oficina lo
//     confirme. Si ningun servicio concuerda queda EN_ESPERA: lo normal es que el chofer haya
//     subido el peaje antes de que la oficina cargue el servicio, asi que se vuelve a evaluar
//     solo (rematchVehicle) cuando se carga o edita un servicio de ese vehiculo.
//  4. No hay limite de peajes por servicio: todos los que caen en su ventana son suyos.
export const evaluateMatch = ({ transitAt, driverId, candidates }) => {
  const transitMs = new Date(transitAt).getTime();
  const windows = candidates.map((service) => ({ service, ...serviceWindow(service) }));

  const started = windows.filter((w) => w.start - TOLERANCIA_ANTES_MS <= transitMs);
  if (started.length === 0) {
    return enEspera("Ningun servicio de este vehiculo habia empezado a esa hora.");
  }

  const active = started.filter((w) => transitMs <= w.returnEnd);
  if (active.length === 0) {
    const last = [...started].sort((a, b) => b.start - a.start)[0];
    return enEspera(
      `El ultimo servicio del vehiculo (${last.service.codigo}) ya debia haber terminado y vuelto ${hoursText(
        transitMs - last.returnEnd
      )} antes.`
    );
  }

  const rank = (w) => [
    driverId && w.service.driverId === driverId ? 1 : 0,
    transitMs <= w.idaEnd ? 1 : 0,
    w.start,
  ];
  const sorted = [...active].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return 0;
  });
  const pick = sorted[0];
  const tramo = tramoAt(pick, transitMs);
  const where = `${tramo === "IDA" ? "durante la ida" : "en la vuelta"} del servicio ${pick.service.codigo}`;

  let asignacion = "AUTO";
  let motivo = `Transito ${where}.`;
  if (driverId && pick.service.driverId && pick.service.driverId !== driverId) {
    asignacion = "SUGERIDO";
    motivo = `Transito ${where}, pero el chofer del mancato no es el del servicio.`;
  } else if (active.length > 1) {
    asignacion = "SUGERIDO";
    motivo = `Hay ${active.length} servicios del vehiculo en curso a esa hora; el mas probable es ${pick.service.codigo} (${tramo === "IDA" ? "ida" : "vuelta"}).`;
  } else if (pick.inferido && windows.length > 1) {
    asignacion = "SUGERIDO";
    motivo = `Transito ${where}, pero el servicio no tiene Fecha de retiro y su horario es una estimacion.`;
  }

  return { recordId: pick.service.id, asignacion, tramo, asignacionMotivo: motivo };
};

const loadCandidates = (vehicleId, transitAt) => {
  const t = new Date(transitAt).getTime();
  return findCandidateServices({
    vehicleId,
    from: new Date(t - BUSQUEDA_ATRAS_MS),
    to: new Date(t + BUSQUEDA_ADELANTE_MS),
  });
};

// Calcula la asignacion de un mancato nuevo o modificado.
export const matchMancato = async ({ vehicleId, driverId, fechaHoraTransito }) => {
  if (!fechaHoraTransito) return enEspera("El mancato no tiene hora de transito.");
  if (!vehicleId) return enEspera("La targa no esta registrada en Vehiculos.");
  const candidates = await loadCandidates(vehicleId, fechaHoraTransito);
  return evaluateMatch({ transitAt: fechaHoraTransito, driverId, candidates });
};

// Servicios del vehiculo cerca del transito, para que la oficina elija a mano. Incluye el tramo
// que correspondería y si el servicio estaba en curso a esa hora.
export const listCandidatesForMancato = async (mancato) => {
  if (!mancato.vehicleId || !mancato.fechaHoraTransito) return [];
  const candidates = await loadCandidates(mancato.vehicleId, mancato.fechaHoraTransito);
  const t = new Date(mancato.fechaHoraTransito).getTime();
  return candidates
    .map((service) => {
      const w = serviceWindow(service);
      return {
        id: service.id,
        codigo: service.codigo,
        estado: service.estado,
        cliente: service.client?.nombre ?? null,
        destinazione: service.destinazione,
        driver: service.driver ? `${service.driver.nombre} ${service.driver.apellido}` : null,
        driverId: service.driverId,
        fechaRetiro: service.fechaRetiro,
        eta: service.eta,
        inferido: w.inferido,
        activo: w.start - TOLERANCIA_ANTES_MS <= t && t <= w.returnEnd,
        tramo: tramoAt(w, t),
        distanciaMs: Math.abs(t - w.start),
      };
    })
    .sort((a, b) => Number(b.activo) - Number(a.activo) || a.distanciaMs - b.distanciaMs)
    .map(({ distanciaMs, ...rest }) => rest);
};

const sameAssignment = (current, next) =>
  current.recordId === next.recordId &&
  current.asignacion === next.asignacion &&
  current.tramo === next.tramo &&
  current.asignacionMotivo === next.asignacionMotivo;

// Vuelve a evaluar los mancatos recientes de un vehiculo que la oficina no fijo a mano
// (AUTO / SUGERIDO / EN_ESPERA). Se llama cuando un servicio de ese vehiculo cambia:
// puede que ahora si exista el servicio que faltaba, o que el horario haya cambiado.
export const rematchVehicle = async (vehicleId) => {
  if (!vehicleId) return { revisados: 0, cambiados: 0 };
  const mancatos = await findAssignableMancatos({
    vehicleId,
    since: new Date(Date.now() - REEVALUAR_DESDE_MS),
  });
  let cambiados = 0;
  for (const m of mancatos) {
    const next = await matchMancato({
      vehicleId: m.vehicleId,
      driverId: m.driverId,
      fechaHoraTransito: m.fechaHoraTransito,
    });
    if (!sameAssignment(m, next)) {
      await updateMancatoAssignment(m.id, next);
      cambiados += 1;
    }
  }
  return { revisados: mancatos.length, cambiados };
};

// Igual, para todos los vehiculos (boton "reasignar" de la oficina, p. ej. tras completar
// muchas Fechas de retiro).
export const rematchAll = async () => {
  const vehicles = await findVehiclesWithAssignableMancatos({
    since: new Date(Date.now() - REEVALUAR_DESDE_MS),
  });
  let revisados = 0;
  let cambiados = 0;
  for (const vehicleId of vehicles) {
    const result = await rematchVehicle(vehicleId);
    revisados += result.revisados;
    cambiados += result.cambiados;
  }
  return { revisados, cambiados };
};

// Para no romper nunca el flujo de un servicio por un problema del cruce.
export const rematchVehicleSafe = (vehicleId) =>
  rematchVehicle(vehicleId).catch((err) => {
    console.error("No se pudieron re-evaluar los mancatos del vehiculo:", err.message);
  });
