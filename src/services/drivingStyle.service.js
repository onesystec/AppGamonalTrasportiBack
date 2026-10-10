import { findDoneRecordsOfDriver } from "../models/meta.model.js";
import { findUserById } from "../models/user.model.js";
import { getFleetDrivingStyle, isOnesystecConfigured, normalizePlate } from "./onesystec.service.js";

const DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const kmOf = (r) => num(r.kilometrosReales) || num(r.kilometros) || num(r.rutaDistanciaKm);

// OneSystec puntua por vehiculo, no por chofer. El puntaje de un chofer es el de los vehiculos que uso en los
// ultimos 30 dias, ponderado por los km que hizo en cada uno (si hizo todo en uno, es el de ese vehiculo; si
// no tiene servicios, el de su vehiculo habitual). Si el vehiculo lo comparten varios choferes, el puntaje
// refleja a todos ellos. Es solo informativo: nunca lanza, y devuelve null si no hay datos suficientes.
export const getMyDrivingStyle = async (actor) => {
  if (!isOnesystecConfigured()) return null;

  const [records, user] = await Promise.all([
    findDoneRecordsOfDriver({ driverId: actor.id, from: new Date(Date.now() - DAYS * DAY_MS) }),
    findUserById(actor.id),
  ]);

  const kmByPlate = new Map();
  for (const r of records) {
    const plate = normalizePlate(r.vehicle?.targa);
    if (plate) kmByPlate.set(plate, (kmByPlate.get(plate) ?? 0) + kmOf(r));
  }
  if (kmByPlate.size === 0 && user?.vehiculoAsignado?.targa) {
    kmByPlate.set(normalizePlate(user.vehiculoAsignado.targa), 1);
  }
  if (kmByPlate.size === 0) return null;

  const fleet = await getFleetDrivingStyle(DAYS);
  if (!fleet) return null;

  let weighted = 0;
  let weights = 0;
  let used = 0;
  for (const vehicle of fleet) {
    const overall = vehicle.scores?.overall;
    // Sin puntaje (pocos km o sin reportes) el vehiculo no cuenta: no significa manejo perfecto.
    if (typeof overall !== "number" || !kmByPlate.has(normalizePlate(vehicle.plate))) continue;
    const weight = kmByPlate.get(normalizePlate(vehicle.plate)) || 1;
    weighted += overall * weight;
    weights += weight;
    used += 1;
  }
  if (weights === 0) return null;
  return { puntaje: Math.round(weighted / weights), dias: DAYS, vehiculos: used };
};
