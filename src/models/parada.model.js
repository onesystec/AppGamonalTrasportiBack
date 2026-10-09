import { prisma } from "../config/prisma.js";

export const deleteParadasByRecord = (recordId) => prisma.paradaVehiculo.deleteMany({ where: { recordId } });

export const createParadas = (data) => prisma.paradaVehiculo.createMany({ data });

export const findParadasByRecordIds = (recordIds) =>
  prisma.paradaVehiculo.findMany({ where: { recordId: { in: recordIds } }, orderBy: { startedAt: "asc" } });

export const deleteParadasOlderThan = (cutoffDate) =>
  prisma.paradaVehiculo.deleteMany({ where: { startedAt: { lt: cutoffDate } } });

// Servicios del vehiculo que se cruzan con una ventana de tiempo, con sus paradas geocodificadas:
// una parada del vehiculo cerca de alguna de ellas es trabajo (carga, descarga, espera).
export const findVehicleRecordsAround = ({ vehicleId, from, to }) =>
  prisma.record.findMany({
    where: {
      vehicleId,
      estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] },
      fechaServicio: { lte: to },
      eta: { gte: from },
    },
    select: { id: true, stops: { select: { lat: true, lng: true } } },
  });

// Carga de combustible del vehiculo en torno a una parada (hora de la carga conocida).
export const findFuelNear = ({ vehicleId, targa, from, to }) =>
  prisma.registroCombustible.findFirst({
    where: { OR: [{ vehicleId }, { targa }], fechaHora: { gte: from, lte: to } },
    select: { id: true },
  });

// Listado para la pantalla de revision. Los filtros opcionales se suman.
export const findParadas = ({ from, to, clases, vehicleId, driverId, recordId, recordIds, limit }) =>
  prisma.paradaVehiculo.findMany({
    where: {
      startedAt: { gte: from, lt: to },
      ...(clases?.length ? { clase: { in: clases } } : {}),
      ...(vehicleId ? { vehicleId } : {}),
      ...(driverId ? { driverId } : {}),
      ...(recordId ? { recordId } : {}),
      // Responsable con areas: solo paradas de servicios de sus areas.
      ...(recordIds ? { recordId: { in: recordIds } } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

export const groupParadasByClase = ({ from, to, recordIds }) =>
  prisma.paradaVehiculo.groupBy({
    by: ["clase"],
    where: { startedAt: { gte: from, lt: to }, ...(recordIds ? { recordId: { in: recordIds } } : {}) },
    _count: { _all: true },
    _sum: { durationMin: true },
  });
