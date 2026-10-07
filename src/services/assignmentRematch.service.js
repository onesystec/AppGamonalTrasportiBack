import { rematchCombustibleVehicleSafe } from "./combustibleMatching.service.js";
import { rematchVehicleSafe } from "./mancatoMatching.service.js";

// Cuando un servicio se crea, edita o borra, todo lo que depende de "que servicio tenia el
// vehiculo a esa hora" se vuelve a evaluar: los peajes (mancato pagamento) y las cargas de
// combustible que todavia no fijo la oficina. Nunca rompe el flujo del servicio.
export const rematchAssignmentsForVehicle = async (vehicleId) => {
  await rematchVehicleSafe(vehicleId);
  await rematchCombustibleVehicleSafe(vehicleId);
};
