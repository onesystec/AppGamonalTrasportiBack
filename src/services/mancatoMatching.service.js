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

export const tramoAt = (window, transitMs) => (transitMs <= window.idaEnd ? "IDA" : "VUELTA");

// Un viaje compacto es UN recorrido del vehiculo (sale, entrega sus servicios en orden y vuelve): sus servicios no
// compiten entre si por un peaje. Cada viaje se junta en una sola ventana:
//   start      cuando sale el primero
//   idaEnd     la ultima entrega estimada (hasta ahi es "ida"; despues, la vuelta)
//   returnEnd  el fin de la vuelta mas tardia
//   llegadas   la hora estimada de llegada a cada parada, en orden y sin retroceder
const collapseViajes = (windows) => {
  const out = [];
  const groups = new Map();
  for (const w of windows) {
    const id = w.service.compactadoId;
    if (!id) {
      out.push(w);
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(w);
  }
  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    members.sort((a, b) => (a.service.compactadoOrden ?? 0) - (b.service.compactadoOrden ?? 0));
    let latest = 0;
    const llegadas = members.map((m) => {
      latest = Math.max(latest, m.idaEnd);
      return latest;
    });
    out.push({
      service: members[0].service,
      start: Math.min(...members.map((m) => m.start)),
      idaEnd: latest,
      returnEnd: Math.max(...members.map((m) => m.returnEnd)),
      inferido: members.every((m) => m.inferido),
      viaje: { members, llegadas },
    });
  }
  return out;
};

// Servicio del viaje al que se carga el peaje: en la ida, la proxima entrega (la parada mas cercana por delante);
// en la vuelta, el ultimo servicio del viaje (de ahi sale el regreso).
const memberForTransit = (pick, transitMs) => {
  if (!pick.viaje) return pick.service;
  const { members, llegadas } = pick.viaje;
  if (transitMs > pick.idaEnd) return members[members.length - 1].service;
  const next = llegadas.findIndex((arrival) => arrival >= transitMs);
  return members[next === -1 ? members.length - 1 : next].service;
};

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
//
// opts permite reutilizarla para otros eventos del vehiculo (ver combustibleMatching.service.js):
//   tolBeforeMs   cuanto antes de la hora de retiro todavia cuenta para el servicio
//   extraAfterMs  margen extra despues de la vuelta esperada
//   noun / subject  como nombrar el evento en los motivos ("Transito" / "del mancato")
//   viajes        los servicios de un viaje compacto cuentan como un solo recorrido (ver collapseViajes)
//   directo       nunca queda SUGERIDO: se asigna (AUTO) al servicio mas probable y las dudas quedan en el motivo
export const evaluateMatch = ({ transitAt, driverId, candidates, opts = {} }) => {
  const tolBefore = opts.tolBeforeMs ?? TOLERANCIA_ANTES_MS;
  const extraAfter = opts.extraAfterMs ?? 0;
  const noun = opts.noun ?? "Transito";
  const subject = opts.subject ?? "del mancato";

  const transitMs = new Date(transitAt).getTime();
  const base = candidates.map((service) => ({ service, ...serviceWindow(service) }));
  const windows = opts.viajes ? collapseViajes(base) : base;

  const started = windows.filter((w) => w.start - tolBefore <= transitMs);
  if (started.length === 0) {
    return enEspera("Ningun servicio de este vehiculo habia empezado a esa hora.");
  }

  const active = started.filter((w) => transitMs <= w.returnEnd + extraAfter);
  if (active.length === 0) {
    const last = [...started].sort((a, b) => b.start - a.start)[0];
    return enEspera(
      `El ultimo servicio del vehiculo (${last.service.codigo}) ya debia haber terminado y vuelto ${hoursText(
        transitMs - last.returnEnd - extraAfter
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
  const chosen = memberForTransit(pick, transitMs);
  const viaje = pick.viaje ? ` del viaje compacto (${pick.viaje.members.map((m) => m.service.codigo).join(", ")})` : "";
  const where = pick.viaje
    ? `${tramo === "IDA" ? "durante la ida" : "en la vuelta"}${viaje}, asignado a ${chosen.codigo} (${
        tramo === "IDA" ? "la proxima entrega" : "el ultimo servicio del viaje"
      })`
    : `${tramo === "IDA" ? "durante la ida" : "en la vuelta"} del servicio ${chosen.codigo}`;

  // Lo que deja alguna duda sobre la asignacion.
  const dudas = [];
  if (driverId && pick.service.driverId && pick.service.driverId !== driverId) {
    dudas.push(`el chofer ${subject} no es el del servicio`);
  }
  if (active.length > 1) dudas.push(`habia ${active.length} servicios del vehiculo en curso a esa hora`);
  if (pick.inferido && windows.length > 1) dudas.push("el servicio no tiene Fecha de retiro y su horario es una estimacion");

  if (opts.directo) {
    const motivo = `${noun} ${where}.${dudas.length ? ` Se eligio el mas probable (${dudas.join("; ")}).` : ""}`;
    return { recordId: chosen.id, asignacion: "AUTO", tramo, asignacionMotivo: motivo };
  }

  let asignacion = "AUTO";
  let motivo = `${noun} ${where}.`;
  if (driverId && pick.service.driverId && pick.service.driverId !== driverId) {
    asignacion = "SUGERIDO";
    motivo = `${noun} ${where}, pero el chofer ${subject} no es el del servicio.`;
  } else if (active.length > 1) {
    asignacion = "SUGERIDO";
    motivo = `Hay ${active.length} servicios del vehiculo en curso a esa hora; el mas probable es ${chosen.codigo} (${tramo === "IDA" ? "ida" : "vuelta"}).`;
  } else if (pick.inferido && windows.length > 1) {
    asignacion = "SUGERIDO";
    motivo = `${noun} ${where}, pero el servicio no tiene Fecha de retiro y su horario es una estimacion.`;
  }

  return { recordId: chosen.id, asignacion, tramo, asignacionMotivo: motivo };
};

export const loadCandidates = (vehicleId, transitAt) => {
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
  // Los peajes se asignan directo al servicio mas probable (sin pedir confirmacion) y un viaje compacto cuenta como
  // un solo recorrido.
  return evaluateMatch({ transitAt: fechaHoraTransito, driverId, candidates, opts: { viajes: true, directo: true } });
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
