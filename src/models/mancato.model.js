import { prisma } from "../config/prisma.js";

const PERSON_SELECT = { select: { id: true, nombre: true, apellido: true } };
const SERVICE_SELECT = {
  select: {
    id: true,
    codigo: true,
    estado: true,
    destinazione: true,
    fechaRetiro: true,
    eta: true,
    driverId: true,
    spedizzione: true,
    extrasPiazzaZona: true,
    client: { select: { nombre: true } },
    driver: PERSON_SELECT,
  },
};
const INCLUDE = { driver: PERSON_SELECT, createdBy: PERSON_SELECT, record: SERVICE_SELECT };

export const createMancato = (data) => prisma.mancatoPagamento.create({ data, include: INCLUDE });

export const findMancatoById = (id) =>
  prisma.mancatoPagamento.findUnique({ where: { id }, include: INCLUDE });

export const findMancatoByNumero = (numero) =>
  prisma.mancatoPagamento.findUnique({ where: { numero }, select: { id: true } });

export const findMancatos = ({ where, orderBy, skip, take }) =>
  prisma.mancatoPagamento.findMany({ where, orderBy, skip, take, include: INCLUDE });

export const countMancatos = (where) => prisma.mancatoPagamento.count({ where });

// Total en plata de un conjunto filtrado (resumen de cada acordeon).
export const sumMancatosCosto = async (where) => {
  const result = await prisma.mancatoPagamento.aggregate({ where, _sum: { costo: true } });
  return Number(result._sum.costo ?? 0);
};

export const updateMancatoById = (id, data) =>
  prisma.mancatoPagamento.update({ where: { id }, data, include: INCLUDE });

export const deleteMancatoById = (id) => prisma.mancatoPagamento.delete({ where: { id } });

export const findVehicleByTarga = (targa) =>
  prisma.vehiculo.findFirst({
    where: { targa: { equals: targa, mode: "insensitive" } },
    select: { id: true },
  });

// Solo lo necesario para las estadisticas (evolucion mensual, antiguedad, deuda por
// chofer): son pocas filas por ano y se calcula todo en memoria.
export const findMancatosForStats = (where) =>
  prisma.mancatoPagamento.findMany({
    where,
    select: {
      costo: true,
      fecha: true,
      fechaVencimiento: true,
      createdAt: true,
      pagado: true,
      pagadoAt: true,
      asignacion: true,
      recordId: true,
      driverId: true,
      driver: { select: { nombre: true, apellido: true } },
    },
  });

export const countActiveChoferes = () =>
  prisma.user.count({ where: { cargo: "CHOFER", estado: "ACTIVO" } });

// ---- Cruce con servicios (ver mancatoMatching.service.js)

// Servicios del vehiculo que podrian ser el dueno de un peaje: ni anulados ni reprogramados
// (esos no se hicieron en ese momento) y con inicio o recepcion dentro de la ventana.
export const findCandidateServices = ({ vehicleId, from, to }) =>
  prisma.record.findMany({
    where: {
      vehicleId,
      // La continuacion de un traspaso copia las fechas del servicio original: no es un servicio
      // distinto para saber de quien es un peaje o una carga de combustible.
      servicioOrigenId: null,
      estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] },
      OR: [
        { fechaRetiro: { gte: from, lte: to } },
        { fechaServicio: { gte: from, lte: to } },
      ],
    },
    select: {
      id: true,
      codigo: true,
      estado: true,
      destinazione: true,
      driverId: true,
      fechaServicio: true,
      fechaRetiro: true,
      eta: true,
      rutaDuracionMin: true,
      client: { select: { nombre: true } },
      driver: PERSON_SELECT,
    },
  });

// Mancatos que el sistema puede volver a asignar (la oficina no los fijo a mano).
export const findAssignableMancatos = ({ vehicleId, since }) =>
  prisma.mancatoPagamento.findMany({
    where: {
      vehicleId,
      asignacion: { in: ["AUTO", "SUGERIDO", "EN_ESPERA"] },
      fechaHoraTransito: { gte: since },
    },
    select: {
      id: true,
      vehicleId: true,
      driverId: true,
      fechaHoraTransito: true,
      recordId: true,
      asignacion: true,
      tramo: true,
      asignacionMotivo: true,
    },
  });

export const findVehiclesWithAssignableMancatos = async ({ since }) => {
  const rows = await prisma.mancatoPagamento.groupBy({
    by: ["vehicleId"],
    where: {
      vehicleId: { not: null },
      asignacion: { in: ["AUTO", "SUGERIDO", "EN_ESPERA"] },
      fechaHoraTransito: { gte: since },
    },
  });
  return rows.map((r) => r.vehicleId);
};

export const updateMancatoAssignment = (id, data) =>
  prisma.mancatoPagamento.update({ where: { id }, data });

export const findRecordForAssignment = (id) =>
  prisma.record.findUnique({
    where: { id },
    select: {
      id: true,
      codigo: true,
      fechaServicio: true,
      fechaRetiro: true,
      eta: true,
      rutaDuracionMin: true,
      spedizzione: true,
      extrasPiazzaZona: true,
    },
  });

// Cuales de estos servicios caen en el filtro de areas de un Responsable.
export const findRecordIdsInArea = (ids, areaWhere) =>
  prisma.record.findMany({ where: { id: { in: ids }, ...areaWhere }, select: { id: true } });

// Peajes asignados a servicios, contados por servicio y tramo (para marcar los servicios a los que falta uno).
export const groupMancatosByRecord = () =>
  prisma.mancatoPagamento.groupBy({
    by: ["recordId", "tramo"],
    where: { recordId: { not: null } },
    _count: { _all: true },
  });

// Suma y cantidad de peajes (mancatos) asignados a cada servicio, para los listados (ver attachFuel en record.service.js).
export const sumMancatosByRecord = () =>
  prisma.mancatoPagamento.groupBy({
    by: ["recordId"],
    where: { recordId: { not: null } },
    _sum: { costo: true },
    _count: { _all: true },
  });
