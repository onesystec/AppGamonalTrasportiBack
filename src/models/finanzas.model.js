import { prisma } from "../config/prisma.js";

// Para series de varios meses: solo columnas numericas, sin joins (son ~1.500 filas).
// areaWhere: filtro de areas del Responsable (utils/areaAccess.js), undefined = todas.
export const findRecordsLite = ({ from, to, driverId, areaWhere }) =>
  prisma.record.findMany({
    where: { fechaServicio: { gte: from, lt: to }, ...(driverId ? { driverId } : {}), ...(areaWhere ?? {}) },
    select: {
      estado: true,
      fechaServicio: true,
      driverId: true,
      horasDia: true,
      horasNoche: true,
      tiempoEspera: true,
      horasEstado: true,
      horaInicioReal: true,
      horaFinReal: true,
      pausaMin: true,
      fechaRetiro: true,
      kilometros: true,
      spedizzione: true,
      kilometrosReales: true,
      kmReparto: true,
      compactadoId: true,
      compactadoOrden: true,
      servicioOrigenId: true,
      _count: { select: { continuaciones: true } },
      rutaDistanciaKm: true,
      areaC: true,
      costoTraforoFrejusBrennero: true,
      peajes: true,
      // Peajes (mancatos) asignados al servicio: mandan sobre el valor a mano (ver utils/tollCost.js).
      mancatos: { select: { costo: true } },
      vignetta: true,
      costoHotel: true,
      costoOtros: true,
      // Combustible a mano y comprobantes asignados (ver utils/fuelCost.js).
      costoCombustible: true,
      combustibles: { select: { monto: true } },
    },
  });

// Un solo mes, con nombres, para las tablas de detalle.
export const findRecordsDetailed = ({ from, to, driverId, areaWhere }) =>
  prisma.record.findMany({
    where: { fechaServicio: { gte: from, lt: to }, ...(driverId ? { driverId } : {}), ...(areaWhere ?? {}) },
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
      horasEstado: true,
      horaInicioReal: true,
      horaFinReal: true,
      pausaMin: true,
      fechaRetiro: true,
      horasNota: true,
      kilometros: true,
      spedizzione: true,
      kilometrosReales: true,
      kmReparto: true,
      compactadoId: true,
      compactadoOrden: true,
      servicioOrigenId: true,
      _count: { select: { continuaciones: true } },
      rutaDistanciaKm: true,
      areaC: true,
      costoTraforoFrejusBrennero: true,
      peajes: true,
      // Peajes (mancatos) asignados al servicio: mandan sobre el valor a mano (ver utils/tollCost.js).
      mancatos: { select: { costo: true } },
      vignetta: true,
      costoHotel: true,
      costoOtros: true,
    },
  });

export const findCombustibleLite = ({ from, to, driverId, areaWhere }) =>
  prisma.registroCombustible.findMany({
    where: { fecha: { gte: from, lte: to }, ...(driverId ? { driverId } : {}), ...(areaWhere ?? {}) },
    select: { monto: true, fecha: true, driverId: true },
  });

// Multas que la empresa pago y todavia no le descontaron al chofer, por chofer.
export const findPendingDeductions = ({ driverId, areaWhere } = {}) =>
  prisma.multa.groupBy({
    by: ["driverId"],
    where: { quienPaga: "A_DESCONTAR", descontado: false, ...(driverId ? { driverId } : {}), ...(areaWhere ?? {}) },
    _sum: { costo: true },
    _count: { _all: true },
  });

// Servicios con combustible cargado a mano Y con comprobantes asignados: los unicos donde puede
// haber una diferencia que auditar (ver fuelNeedsAudit). Son pocos, asi que se filtran en memoria.
export const findRecordsForFuelAudit = ({ from, to, areaWhere }) =>
  prisma.record.findMany({
    where: {
      ...(areaWhere ?? {}),
      fechaServicio: { gte: from, lt: to },
      costoCombustible: { gt: 0 },
      combustibles: { some: {} },
    },
    orderBy: { fechaServicio: "desc" },
    select: {
      id: true,
      codigo: true,
      fechaServicio: true,
      destinazione: true,
      costoCombustible: true,
      driver: { select: { nombre: true, apellido: true } },
      client: { select: { nombre: true } },
      combustibles: { select: { monto: true } },
    },
  });
