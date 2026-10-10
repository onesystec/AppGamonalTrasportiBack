import { prisma } from "../config/prisma.js";

// Servicios que todavia se pueden compactar en un viaje: abiertos (aun no terminados).
export const OPEN_STATES = ["IN_SOSPESO", "IN_CONSEGNA", "RITIRATO"];

// Los ultimos servicios creados que siguen abiertos, sin compactar y que no son la continuacion de un traspaso.
export const findCompactableRecords = ({ spedizzioneFilter, limit = 60 } = {}) =>
  prisma.record.findMany({
    // Incluye la continuacion de un traspaso (el servicio que recibe otro chofer): se puede llevar junto con
    // los servicios propios de ese chofer.
    where: { estado: { in: OPEN_STATES }, compactadoId: null, ...(spedizzioneFilter ?? {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      codigo: true,
      destinazione: true,
      ciudad: true,
      estado: true,
      eta: true,
      fechaServicio: true,
      createdAt: true,
      spedizzione: true,
      extrasPiazzaZona: true,
      servicioOrigenId: true,
      servicioOrigen: { select: { codigo: true, driver: { select: { nombre: true, apellido: true } } } },
      driver: { select: { id: true, nombre: true, apellido: true } },
      vehicle: { select: { id: true, targa: true } },
      client: { select: { nombre: true } },
    },
  });

// Lo justo para validar si unos servicios se pueden poner en un mismo viaje.
export const findRecordsForCompact = (ids) =>
  prisma.record.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      codigo: true,
      estado: true,
      eta: true,
      driverId: true,
      vehicleId: true,
      spedizzione: true,
      extrasPiazzaZona: true,
      horasEstado: true,
      compactadoId: true,
      compactadoOrden: true,
      driver: { select: { nombre: true, apellido: true } },
      vehicle: { select: { targa: true } },
    },
  });

const MEMBER_SELECT = {
  id: true,
  codigo: true,
  destinazione: true,
  eta: true,
  estado: true,
  driverId: true,
  vehicleId: true,
  spedizzione: true,
  extrasPiazzaZona: true,
  horasEstado: true,
  compactadoId: true,
  compactadoOrden: true,
  sinPeajeIda: true,
  sinPeajeVuelta: true,
  sinCombustible: true,
  kilometros: true,
  kilometrosReales: true,
  rutaDistanciaKm: true,
  // Traspaso entre choferes (continuacion = servicio recibido de otro chofer; original = el que entrego).
  servicioOrigenId: true,
  traspasoHora: true,
  continuaciones: { select: { traspasoHora: true }, take: 1 },
  servicioOrigen: { select: { driver: { select: { nombre: true, apellido: true } } } },
  _count: { select: { combustibles: true } },
};

export const findGroupMembers = (compactadoId) =>
  prisma.record.findMany({ where: { compactadoId }, orderBy: { compactadoOrden: "asc" }, select: MEMBER_SELECT });

export const findMembersOfGroups = (groupIds) =>
  prisma.record.findMany({
    where: { compactadoId: { in: groupIds } },
    orderBy: [{ compactadoId: "asc" }, { compactadoOrden: "asc" }],
    select: MEMBER_SELECT,
  });

// items: [{ id, orden }] -> todos quedan en el viaje `compactadoId` con ese orden (en una sola transaccion).
export const assignGroup = (compactadoId, items) =>
  prisma.$transaction(
    items.map(({ id, orden }) =>
      prisma.record.update({ where: { id }, data: { compactadoId, compactadoOrden: orden }, select: { id: true } })
    )
  );

export const clearGroup = (ids) =>
  prisma.record.updateMany({ where: { id: { in: ids } }, data: { compactadoId: null, compactadoOrden: null } });

// Marca como entregados los servicios abiertos de un viaje cuando el chofer lo termina.
export const markGroupDelivered = (compactadoId) =>
  prisma.record.updateMany({
    where: { compactadoId, estado: { in: OPEN_STATES } },
    data: { estado: "CONSEGNATO" },
  });
