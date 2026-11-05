import { findRecordForAssignment } from "../models/mancato.model.js";
import { AppError } from "../utils/AppError.js";
import { canAccessRecordArea } from "../utils/areaAccess.js";

// Servicio al que el chofer sube un peaje o un comprobante de combustible desde dentro del propio servicio: tiene que ser suyo (la oficina, uno de sus
// areas). Devuelve el servicio con los datos que hacen falta para asignar.
export const resolveServicioParaSubir = async (actor, recordId) => {
  const service = await findRecordForAssignment(recordId);
  if (!service) throw new AppError("Servicio no encontrado", 404);
  const privileged = actor.cargo === "OWNER" || actor.cargo === "ADMIN";
  if (privileged ? !canAccessRecordArea(actor, service) : service.driverId !== actor.id) {
    throw new AppError("Ese servicio no es tuyo", 403);
  }
  return service;
};
