import { healCrossedCombustibles, rematchCombustibleVehicleSafe } from "./combustibleMatching.service.js";
import { healCrossedMancatos, rematchVehicleSafe } from "./mancatoMatching.service.js";

// Cuando un servicio se crea, edita o borra, todo lo que depende de "que servicio tenia el
// vehiculo a esa hora" se vuelve a evaluar: los peajes (mancato pagamento) y las cargas de
// combustible que todavia no fijo la oficina. Nunca rompe el flujo del servicio.
export const rematchAssignmentsForVehicle = async (vehicleId) => {
  await rematchVehicleSafe(vehicleId);
  await rematchCombustibleVehicleSafe(vehicleId);
};

// Corrige de una vez los peajes y las cargas de combustible que quedaron asignados al servicio de otra targa. Se llama al arrancar el servidor
// (ver server.js): es rapido (una consulta por tipo) y no hace nada si no hay cruces.
export const healCrossedAssignments = async () => {
  const [mancatos, combustibles] = await Promise.all([healCrossedMancatos(), healCrossedCombustibles()]);
  if (mancatos || combustibles) console.log(`[asignaciones] corregidos por targa distinta: ${mancatos} peajes, ${combustibles} cargas de combustible`);
  return { mancatos, combustibles };
};
