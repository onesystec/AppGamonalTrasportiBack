import { prisma } from "../config/prisma.js";

const PERSON_SELECT = { select: { id: true, nombre: true, apellido: true } };
const INCLUDE = { driver: PERSON_SELECT, createdBy: PERSON_SELECT };

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
      driverId: true,
      driver: { select: { nombre: true, apellido: true } },
    },
  });

export const countActiveChoferes = () =>
  prisma.user.count({ where: { cargo: "CHOFER", estado: "ACTIVO" } });
