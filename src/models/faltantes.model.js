import { prisma } from "../config/prisma.js";
import { FALTANTES_ESTADOS } from "../config/faltantes.js";

// Servicios terminados de unos vehiculos en una ventana: para sumar los litros estimados de cada vehiculo por dia.
export const findFinishedForVehicles = ({ vehicleIds, gte, lt }) =>
  prisma.record.findMany({
    where: { vehicleId: { in: vehicleIds }, estado: { in: FALTANTES_ESTADOS }, fechaServicio: { gte, lt } },
    select: {
      vehicleId: true,
      fechaServicio: true,
      kilometrosReales: true,
      kilometros: true,
      spedizzione: true,
      rutaDistanciaKm: true,
      sinCombustible: true,
      vehicle: { select: { categoria: true } },
    },
  });

// Comprobantes de combustible de esos vehiculos en la ventana (por dia de la carga).
export const findFuelForVehicles = ({ vehicleIds, gte, lt }) =>
  prisma.registroCombustible.findMany({
    where: { vehicleId: { in: vehicleIds }, fecha: { gte, lt } },
    select: { vehicleId: true, fecha: true },
  });

// Servicios que ya podrian estar con faltantes y a cuyo chofer todavia no se le aviso.
export const findRecordsToRemind = ({ gte, lt }) =>
  prisma.record.findMany({
    where: {
      estado: { in: FALTANTES_ESTADOS },
      fechaServicio: { gte, lt },
      faltantesAvisadoAt: null,
      faltantesExcepcion: false,
      driver: { estado: "ACTIVO" },
    },
    select: {
      id: true,
      codigo: true,
      driverId: true,
      estado: true,
      fechaServicio: true,
      horaFinReal: true,
      eta: true,
      kilometrosReales: true,
      kilometros: true,
      spedizzione: true,
      rutaDistanciaKm: true,
      sinPeajeIda: true,
      sinPeajeVuelta: true,
      sinCombustible: true,
      vehicleId: true,
      vehicle: { select: { categoria: true } },
      mancatos: { select: { tramo: true } },
      combustibles: { select: { id: true } },
    },
  });

export const markRemindedByIds = (ids) =>
  prisma.record.updateMany({ where: { id: { in: ids } }, data: { faltantesAvisadoAt: new Date() } });
