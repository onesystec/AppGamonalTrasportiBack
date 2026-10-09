import { prisma } from "../config/prisma.js";

const LIST_SELECT = {
  id: true,
  choferId: true,
  chofer: { select: { nombre: true, apellido: true } },
  anio: true,
  mes: true,
  nombreArchivo: true,
  firmadaAt: true,
  createdAt: true,
};

export const findBustasPaga = ({ choferId, anio }) =>
  prisma.bustaPaga.findMany({
    where: { ...(choferId ? { choferId } : {}), ...(anio ? { anio } : {}) },
    select: LIST_SELECT,
    orderBy: [{ anio: "desc" }, { mes: "desc" }],
  });

export const findBustaPagaById = (id) => prisma.bustaPaga.findUnique({ where: { id } });

export const findBustaPagaDeChoferMes = (choferId, anio, mes) =>
  prisma.bustaPaga.findUnique({ where: { choferId_anio_mes: { choferId, anio, mes } } });

export const createBustaPaga = (data) => prisma.bustaPaga.create({ data });

export const updateBustaPaga = (id, data) => prisma.bustaPaga.update({ where: { id }, data });

export const deleteBustaPaga = (id) => prisma.bustaPaga.delete({ where: { id } });

export const logAcceso = (data) => prisma.bustaPagaAcceso.create({ data });

export const findAccesos = (bustaPagaId) =>
  prisma.bustaPagaAcceso.findMany({ where: { bustaPagaId }, orderBy: { createdAt: "asc" }, take: 100 });

export const countBustasDeChofer = (choferId) => prisma.bustaPaga.count({ where: { choferId } });
