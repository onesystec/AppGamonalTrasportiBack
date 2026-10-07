import { prisma } from "../config/prisma.js";

// Para series de varios meses: solo columnas numericas, sin joins (son ~1.500 filas).
export const findRecordsLite = ({ from, to, driverId }) =>
  prisma.record.findMany({
    where: { fechaServicio: { gte: from, lt: to }, ...(driverId ? { driverId } : {}) },
    select: {
      estado: true,
      fechaServicio: true,
      driverId: true,
      horasDia: true,
      horasNoche: true,
      tiempoEspera: true,
      kilometros: true,
      kilometrosReales: true,
      rutaDistanciaKm: true,
      areaC: true,
      costoTraforoFrejusBrennero: true,
      peajes: true,
      vignetta: true,
      costoHotel: true,
      costoOtros: true,
    },
  });

// Un solo mes, con nombres, para las tablas de detalle.
export const findRecordsDetailed = ({ from, to, driverId }) =>
  prisma.record.findMany({
    where: { fechaServicio: { gte: from, lt: to }, ...(driverId ? { driverId } : {}) },
    orderBy: { fechaServicio: "asc" },
    select: {
      id: true,
      codigo: true,
      estado: true,
      fechaServicio: true,
      destinazione: true,
      driverId: true,
      driver: { select: { nombre: true, apellido: true } },
      client: { select: { nombre: true } },
      horasDia: true,
      horasNoche: true,
      tiempoEspera: true,
      kilometros: true,
      kilometrosReales: true,
      rutaDistanciaKm: true,
      areaC: true,
      costoTraforoFrejusBrennero: true,
      peajes: true,
      vignetta: true,
      costoHotel: true,
      costoOtros: true,
    },
  });

export const findCombustibleLite = ({ from, to, driverId }) =>
  prisma.registroCombustible.findMany({
    where: { fecha: { gte: from, lte: to }, ...(driverId ? { driverId } : {}) },
    select: { monto: true, fecha: true, driverId: true },
  });

// Multas que la empresa pago y todavia no le descontaron al chofer, por chofer.
export const findPendingDeductions = ({ driverId } = {}) =>
  prisma.multa.groupBy({
    by: ["driverId"],
    where: { quienPaga: "A_DESCONTAR", descontado: false, ...(driverId ? { driverId } : {}) },
    _sum: { costo: true },
    _count: { _all: true },
  });
