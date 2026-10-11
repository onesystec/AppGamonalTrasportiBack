import { prisma } from "../config/prisma.js";

export const findAllPeajes = () =>
  prisma.peaje.findMany({
    select: { id: true, nombre: true, operador: true, tipo: true, lat: true, lng: true, carriles: true },
    orderBy: [{ lat: "asc" }],
  });
