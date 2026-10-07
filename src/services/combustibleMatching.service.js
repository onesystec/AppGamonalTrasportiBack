import {
  findAssignableCombustibles,
  findVehiclesWithAssignableCombustibles,
  updateCombustibleAssignment,
} from "../models/combustible.model.js";
import { evaluateMatch, listCandidatesForMancato, loadCandidates } from "./mancatoMatching.service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Una carga se imputa al servicio que tenia el vehiculo a esa hora (el mismo criterio que los
// peajes de mancato pagamento: ver mancatoMatching.service.js). Se cargan combustible antes de
// salir (por eso una tolerancia mayor antes del retiro) y al volver (margen extra al final).
const OPTS = { tolBeforeMs: 3 * HOUR, extraAfterMs: 2 * HOUR, noun: "Carga", subject: "de la carga" };

// A diferencia de un mancato, una carga sin servicio NO vence: queda EN_ESPERA hasta que
// aparezca uno que encaje. Por eso se re-evaluan todas las no fijadas, sin limite de edad
// razonable (6 meses) y sin estado "fuera de horario".
const REEVALUAR_DESDE_MS = 180 * DAY;

const enEspera = (asignacionMotivo) => ({ recordId: null, asignacion: "EN_ESPERA", asignacionMotivo });

export const matchCombustible = async ({ vehicleId, driverId, fechaHora }) => {
  if (!fechaHora) return enEspera("La carga no tiene hora.");
  if (!vehicleId) return enEspera("La targa no esta registrada en Vehiculos.");
  const candidates = await loadCandidates(vehicleId, fechaHora);
  const { recordId, asignacion, asignacionMotivo } = evaluateMatch({
    transitAt: fechaHora,
    driverId,
    candidates,
    opts: OPTS,
  });
  return { recordId, asignacion, asignacionMotivo };
};

// Servicios del vehiculo cerca de la carga, para que la oficina elija a mano.
export const listCandidatesForCombustible = (carga) =>
  listCandidatesForMancato({ vehicleId: carga.vehicleId, fechaHoraTransito: carga.fechaHora });

const sameAssignment = (current, next) =>
  current.recordId === next.recordId &&
  current.asignacion === next.asignacion &&
  current.asignacionMotivo === next.asignacionMotivo;

// Vuelve a evaluar las cargas de un vehiculo que la oficina no fijo a mano (AUTO / SUGERIDO /
// EN_ESPERA) cuando un servicio de ese vehiculo se crea, edita o borra.
export const rematchCombustibleVehicle = async (vehicleId) => {
  if (!vehicleId) return { revisados: 0, cambiados: 0 };
  const cargas = await findAssignableCombustibles({
    vehicleId,
    since: new Date(Date.now() - REEVALUAR_DESDE_MS),
  });
  let cambiados = 0;
  for (const c of cargas) {
    const next = await matchCombustible({ vehicleId: c.vehicleId, driverId: c.driverId, fechaHora: c.fechaHora });
    if (!sameAssignment(c, next)) {
      await updateCombustibleAssignment(c.id, next);
      cambiados += 1;
    }
  }
  return { revisados: cargas.length, cambiados };
};

export const rematchAllCombustible = async () => {
  const vehicles = await findVehiclesWithAssignableCombustibles({
    since: new Date(Date.now() - REEVALUAR_DESDE_MS),
  });
  let revisados = 0;
  let cambiados = 0;
  for (const vehicleId of vehicles) {
    const result = await rematchCombustibleVehicle(vehicleId);
    revisados += result.revisados;
    cambiados += result.cambiados;
  }
  return { revisados, cambiados };
};

export const rematchCombustibleVehicleSafe = (vehicleId) =>
  rematchCombustibleVehicle(vehicleId).catch((err) => {
    console.error("No se pudieron re-evaluar las cargas de combustible del vehiculo:", err.message);
  });
