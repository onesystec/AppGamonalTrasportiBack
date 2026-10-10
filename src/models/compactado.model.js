import { VIAJES_DESDE_DATE } from "../config/viajes.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

// Servicios abiertos (aun no terminados).
export const OPEN_STATES = ["IN_SOSPESO", "IN_CONSEGNA", "RITIRATO"];

// Se puede compactar un servicio abierto o uno ya entregado al que todavia no se le cargaron horas (los que
// se crean cuando el viaje ya paso: la ETA vencida no importa). Con horas cargadas ya no.
export const isCompactable = (r) =>
  OPEN_STATES.includes(r.estado) || (r.estado === "CONSEGNATO" && !r.horasEstado);

// Los ultimos servicios creados que se pueden compactar (abiertos, o entregados sin horas) y aun no estan en un viaje.
export const findCompactableRecords = ({ spedizzioneFilter, limit = 60 } = {}) =>
  prisma.record.findMany({
    // Incluye la continuacion de un traspaso (el servicio que recibe otro chofer): se puede llevar junto con
    // los servicios propios de ese chofer.
    where: {
      OR: [{ estado: { in: OPEN_STATES } }, { estado: "CONSEGNATO", horasEstado: null }],
      compactadoId: null,
      fechaServicio: { gte: VIAJES_DESDE_DATE },
      ...(spedizzioneFilter ?? {}),
    },
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
      fechaServicio: true,
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
  fechaServicio: true,
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
  kmReparto: true,
  circuito: true,
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
  prisma.record.updateMany({
    where: { id: { in: ids } },
    data: { compactadoId: null, compactadoOrden: null, kmReparto: Prisma.DbNull },
  });

// El chofer mueve el estado de un servicio abierto del viaje: se mueve todo el viaje junto (los ya entregados o
// anulados no se tocan).
export const setGroupOpenEstado = (compactadoId, estado) =>
  prisma.record.updateMany({ where: { compactadoId, estado: { in: OPEN_STATES } }, data: { estado } });

// Guarda los km reales de cada servicio del viaje (`items` = [{ id, km }]) y, en el principal, como se repartieron.
export const setGroupKm = (items, principalId, meta) =>
  prisma.$transaction(
    items.map(({ id, km }) =>
      prisma.record.update({
        where: { id },
        data: { kilometrosReales: km, ...(id === principalId ? { kmReparto: meta } : {}) },
        select: { id: true },
      })
    )
  );

// Marca como entregados los servicios abiertos de un viaje cuando el chofer lo termina.
export const markGroupDelivered = (compactadoId) =>
  prisma.record.updateMany({
    where: { compactadoId, estado: { in: OPEN_STATES } },
    data: { estado: "CONSEGNATO" },
  });
