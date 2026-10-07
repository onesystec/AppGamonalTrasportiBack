import { prisma } from "../config/prisma.js";

const PERSON_SELECT = { select: { id: true, nombre: true, apellido: true } };
const INCLUDE = { driver: PERSON_SELECT, createdBy: PERSON_SELECT };

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
