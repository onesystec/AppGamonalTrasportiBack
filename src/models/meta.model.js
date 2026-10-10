import { prisma } from "../config/prisma.js";

// Servicios hechos (entregados o retirados) de unos choferes en una ventana: solo lo necesario para
// sumar kilometros. No se recorta por area: los km del chofer cuentan completos para su meta.
export const findDoneRecordsForKm = ({ from, to, driverIds }) =>
  prisma.record.findMany({
    where: {
      fechaServicio: { gte: from, lt: to },
      estado: { in: ["CONSEGNATO", "RITIRATO"] },
      ...(driverIds ? { driverId: { in: driverIds } } : {}),
    },
    select: {
      driverId: true,
      fechaServicio: true,
      kilometrosReales: true,
      kilometros: true,
      rutaDistanciaKm: true,
    },
  });

// Servicios hechos de un chofer desde una fecha que tienen su jornada cargada, con el estilo de manejo de
// esa jornada si ya se calculo (ver drivingStyle.service.js).
export const findDriverServicesForEstilo = ({ driverId, from }) =>
  prisma.record.findMany({
    where: {
      driverId,
      fechaServicio: { gte: from },
      estado: { in: ["CONSEGNATO", "RITIRATO"] },
      horaInicioReal: { not: null },
      horaFinReal: { not: null },
    },
    select: { id: true, horaFinReal: true, estiloManejo: true, estiloCalculadoAt: true },
  });

// Usuarios que manejan: choferes y cualquier otro usuario al que se le haya puesto nivel.
export const findDrivingUsers = () =>
  prisma.user.findMany({
    where: { estado: "ACTIVO", OR: [{ cargo: "CHOFER" }, { nivelChofer: { not: null } }] },
    select: { id: true, nombre: true, apellido: true, cargo: true, nivelChofer: true, grupo: true },
    orderBy: [{ nombre: "asc" }, { apellido: "asc" }],
  });
