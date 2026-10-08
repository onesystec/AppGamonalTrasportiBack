import { prisma } from "../config/prisma.js";

const PERSON = { select: { id: true, nombre: true, apellido: true } };
const INCLUDE = { driver: PERSON, creadoPor: PERSON, revisadoPor: PERSON };

export const createPermiso = (data) => prisma.permiso.create({ data, include: INCLUDE });

export const findPermisoById = (id) => prisma.permiso.findUnique({ where: { id }, include: INCLUDE });

export const findPermisos = ({ where, take }) =>
  prisma.permiso.findMany({ where, take, orderBy: { solicitadoAt: "desc" }, include: INCLUDE });

export const updatePermisoById = (id, data) => prisma.permiso.update({ where: { id }, data, include: INCLUDE });

export const deletePermisoById = (id) => prisma.permiso.delete({ where: { id } });

// Permisos vigentes (pendientes o aprobados) que se pisan con un rango de dias.
export const findOverlappingPermisos = (driverId, desde, hasta) =>
  prisma.permiso.findMany({
    where: {
      driverId,
      estado: { in: ["PENDIENTE", "APROBADO"] },
      fechaDesde: { lte: hasta },
      fechaHasta: { gte: desde },
    },
    select: { id: true, fechaDesde: true, fechaHasta: true, estado: true },
  });

// "Chofer" a efectos del calendario es cualquier usuario que maneja: choferes, responsables y admin.
export const findChoferById = (id) =>
  prisma.user.findUnique({
    where: { id },
    select: { id: true, nombre: true, apellido: true, cargo: true, createdAt: true },
  });

// Servicios que cuentan como "dia trabajado": todos menos los anulados o reprogramados.
export const findWorkedRecordsInRange = (driverId, gte, lt) =>
  prisma.record.findMany({
    where: { driverId, fechaServicio: { gte, lt }, estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] } },
    select: { fechaServicio: true },
  });

// Primer y ultimo servicio (no anulado) del chofer.
export const findWorkedRecordRange = async (driverId) => {
  const result = await prisma.record.aggregate({
    where: { driverId, estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] } },
    _min: { fechaServicio: true },
    _max: { fechaServicio: true },
  });
  return { first: result._min.fechaServicio, last: result._max.fechaServicio };
};

export const findActiveChoferes = () =>
  prisma.user.findMany({
    where: { estado: "ACTIVO" },
    select: { id: true, nombre: true, apellido: true, cargo: true },
    orderBy: [{ nombre: "asc" }, { apellido: "asc" }],
  });

export const countPendingPermisosByDriver = (driverIds) =>
  prisma.permiso.groupBy({
    by: ["driverId"],
    where: { driverId: { in: driverIds }, estado: "PENDIENTE" },
    _count: { _all: true },
  });

// Permisos aprobados "con cupo" (los que cuentan para el tope) que tocan un rango de dias.
export const findApprovedQuotaPermisos = (desde, hasta, tipos) =>
  prisma.permiso.findMany({
    where: { estado: "APROBADO", tipo: { in: tipos }, fechaDesde: { lte: hasta }, fechaHasta: { gte: desde } },
    select: { id: true, driverId: true, fechaDesde: true, fechaHasta: true },
  });

// Permisos pendientes o aprobados de varios choferes en un rango (asistencia de muchos choferes).
export const findPermisosForDrivers = (driverIds, desde, hasta) =>
  prisma.permiso.findMany({
    where: {
      driverId: { in: driverIds },
      estado: { in: ["PENDIENTE", "APROBADO"] },
      fechaDesde: { lte: hasta },
      fechaHasta: { gte: desde },
    },
    select: { id: true, driverId: true, tipo: true, estado: true, motivo: true, fechaDesde: true, fechaHasta: true },
  });

export const findWorkedRecordsForDrivers = (driverIds, gte, lt) =>
  prisma.record.findMany({
    where: { driverId: { in: driverIds }, fechaServicio: { gte, lt }, estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] } },
    select: { driverId: true, fechaServicio: true },
  });

export const findDriversStart = async (driverIds) => {
  const [users, firsts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: driverIds } }, select: { id: true, createdAt: true } }),
    prisma.record.groupBy({
      by: ["driverId"],
      where: { driverId: { in: driverIds }, estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] } },
      _min: { fechaServicio: true },
    }),
  ]);
  return { users, firsts };
};

export const getConfig = (clave) => prisma.configuracion.findUnique({ where: { clave } });

export const setConfig = (clave, valor) =>
  prisma.configuracion.upsert({ where: { clave }, update: { valor }, create: { clave, valor } });
