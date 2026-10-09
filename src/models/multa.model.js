import { prisma } from "../config/prisma.js";

const PERSON_SELECT = { select: { id: true, nombre: true, apellido: true } };
const INCLUDE = { driver: PERSON_SELECT, createdBy: PERSON_SELECT };

export const createMulta = (data) => prisma.multa.create({ data, include: INCLUDE });

export const findMultaById = (id) => prisma.multa.findUnique({ where: { id }, include: INCLUDE });

export const findMultaByNumero = (numeroVerbale) =>
  prisma.multa.findUnique({ where: { numeroVerbale }, select: { id: true } });

export const findMultas = ({ where, orderBy, skip, take }) =>
  prisma.multa.findMany({ where, orderBy, skip, take, include: INCLUDE });

export const countMultas = (where) => prisma.multa.count({ where });

// Total en plata de un conjunto filtrado (resumen de cada acordeon).
export const sumMultasCosto = async (where) => {
  const result = await prisma.multa.aggregate({ where, _sum: { costo: true } });
  return Number(result._sum.costo ?? 0);
};

export const updateMultaById = (id, data) => prisma.multa.update({ where: { id }, data, include: INCLUDE });

export const deleteMultaById = (id) => prisma.multa.delete({ where: { id } });

export const findVehicleByTarga = (targa) =>
  prisma.vehiculo.findFirst({
    where: { targa: { equals: targa, mode: "insensitive" } },
    select: { id: true },
  });

// Solo lo necesario para las estadisticas: son pocas filas por ano y se calcula en memoria.
export const findMultasForStats = (where) =>
  prisma.multa.findMany({
    where,
    select: {
      costo: true,
      fechaRecepcion: true,
      fechaVencimiento: true,
      createdAt: true,
      pagado: true,
      pagadoAt: true,
      quienPaga: true,
      descontado: true,
      comprobanteChoferAt: true,
      driverId: true,
      driver: { select: { nombre: true, apellido: true } },
    },
  });

export const countActiveChoferes = () =>
  prisma.user.count({ where: { cargo: "CHOFER", estado: "ACTIVO" } });

// Servicios (no anulados) de un vehiculo dentro de un rango: para sugerir quien lo llevaba.
export const findServicesByVehicleInRange = (vehicleId, gte, lt, areaWhere) =>
  prisma.record.findMany({
    where: { vehicleId, fechaServicio: { gte, lt }, estado: { not: "ANNULLATO" }, ...(areaWhere ?? {}) },
    select: { fechaServicio: true, driver: { select: { id: true, nombre: true, apellido: true } } },
    orderBy: { fechaServicio: "asc" },
  });

// Choferes activos con ese vehiculo asignado como habitual (plan B de la sugerencia).
export const findAssignedDrivers = (vehicleId) =>
  prisma.user.findMany({
    where: { vehiculoAsignadoId: vehicleId, estado: "ACTIVO" },
    select: { id: true, nombre: true, apellido: true },
  });

// Multas abiertas (sin pagar) que vencen antes de `limitDate`, mas las vencidas: alertas.
export const findOpenMultasDueBefore = (where, take) =>
  prisma.multa.findMany({
    where,
    orderBy: [{ fechaVencimiento: "asc" }, { createdAt: "asc" }],
    take,
    select: {
      id: true,
      numeroVerbale: true,
      targa: true,
      costo: true,
      fechaVencimiento: true,
      quienPaga: true,
      driver: { select: { nombre: true, apellido: true } },
    },
  });
