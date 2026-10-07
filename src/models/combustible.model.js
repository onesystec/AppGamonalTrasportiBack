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
    client: { select: { nombre: true } },
    driver: PERSON_SELECT,
  },
};
const INCLUDE = { driver: PERSON_SELECT, createdBy: PERSON_SELECT, record: SERVICE_SELECT };

export const createCombustible = (data) => prisma.registroCombustible.create({ data, include: INCLUDE });

export const findCombustibleById = (id) =>
  prisma.registroCombustible.findUnique({ where: { id }, include: INCLUDE });

export const findCombustibles = ({ where, orderBy, skip, take }) =>
  prisma.registroCombustible.findMany({ where, orderBy, skip, take, include: INCLUDE });

export const countCombustibles = (where) => prisma.registroCombustible.count({ where });

// Total en plata de un conjunto filtrado (encabezado de cada acordeon).
export const sumCombustibleMonto = async (where) => {
  const result = await prisma.registroCombustible.aggregate({ where, _sum: { monto: true } });
  return Number(result._sum.monto ?? 0);
};

export const updateCombustibleById = (id, data) =>
  prisma.registroCombustible.update({ where: { id }, data, include: INCLUDE });

export const deleteCombustibleById = (id) => prisma.registroCombustible.delete({ where: { id } });

export const findVehicleByTarga = (targa) =>
  prisma.vehiculo.findFirst({
    where: { targa: { equals: targa, mode: "insensitive" } },
    select: { id: true },
  });

// Solo lo necesario para las estadisticas (serie mensual, gasto por area y por chofer):
// son pocas filas por mes y se calcula todo en memoria.
export const findCombustiblesForStats = (where) =>
  prisma.registroCombustible.findMany({
    where,
    select: {
      monto: true,
      fecha: true,
      area: true,
      metodo: true,
      driverId: true,
      driver: { select: { nombre: true, apellido: true } },
    },
  });

// Nombres de gasolinera ya usados (con cuantas veces), para sugerirlos al cargar y evitar
// "Eni", "ENI" y "Eni Roma" como tres gasolineras distintas.
export const findMetodoUsage = (where) =>
  prisma.registroCombustible.groupBy({
    by: ["metodo"],
    where,
    _count: { _all: true },
    orderBy: { _count: { metodo: "desc" } },
    take: 50,
  });

export const countActiveChoferes = () =>
  prisma.user.count({ where: { cargo: "CHOFER", estado: "ACTIVO" } });

// ---- Cruce con servicios (ver combustibleMatching.service.js)

// Cargas que el sistema puede volver a asignar (la oficina no las fijo a mano).
export const findAssignableCombustibles = ({ vehicleId, since }) =>
  prisma.registroCombustible.findMany({
    where: {
      vehicleId,
      asignacion: { in: ["AUTO", "SUGERIDO", "EN_ESPERA"] },
      fechaHora: { gte: since },
    },
    select: {
      id: true,
      vehicleId: true,
      driverId: true,
      fechaHora: true,
      recordId: true,
      asignacion: true,
      asignacionMotivo: true,
    },
  });

export const findVehiclesWithAssignableCombustibles = async ({ since }) => {
  const rows = await prisma.registroCombustible.groupBy({
    by: ["vehicleId"],
    where: {
      vehicleId: { not: null },
      asignacion: { in: ["AUTO", "SUGERIDO", "EN_ESPERA"] },
      fechaHora: { gte: since },
    },
  });
  return rows.map((r) => r.vehicleId);
};

export const updateCombustibleAssignment = (id, data) =>
  prisma.registroCombustible.update({ where: { id }, data });

// Misma targa, mismo monto y una hora muy cercana: casi seguro es el mismo comprobante subido
// dos veces (por el chofer y por la oficina, por ejemplo).
export const findDuplicateCombustible = ({ targa, monto, from, to }) =>
  prisma.registroCombustible.findFirst({
    where: { targa, monto, fechaHora: { gte: from, lte: to } },
    select: { id: true, fechaHora: true, driver: PERSON_SELECT },
  });

// Cantidad de cargas por estado de asignacion dentro de un alcance (para los avisos).
export const countCombustibleByAsignacion = (where) =>
  prisma.registroCombustible.groupBy({ by: ["asignacion"], where, _count: { _all: true } });

// Suma y cantidad de comprobantes asignados a cada servicio: el costo de combustible de un
// servicio es esto (si tiene comprobantes) o, si no, el valor cargado a mano.
export const groupFuelByRecord = () =>
  prisma.registroCombustible.groupBy({
    by: ["recordId"],
    where: { recordId: { not: null } },
    _sum: { monto: true },
    _count: { _all: true },
  });
