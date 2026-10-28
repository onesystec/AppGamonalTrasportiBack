import { prisma } from "../config/prisma.js";

// Servicios hechos de un chofer desde una fecha, con el estilo de manejo de su tramo si ya se calculo (ver drivingStyle.service.js).
// Con jornada declarada o, si no, con hora de salida (fechaRetiro): de ahi sale el tramo que se le pide a OneSystec.
export const findDriverServicesForEstilo = ({ driverId, from }) =>
  prisma.record.findMany({
    where: {
      driverId,
      fechaServicio: { gte: from },
      estado: { in: ["CONSEGNATO", "RITIRATO"] },
      OR: [{ horaInicioReal: { not: null }, horaFinReal: { not: null } }, { fechaRetiro: { not: null } }],
    },
    select: {
      id: true,
      horaInicioReal: true,
      horaFinReal: true,
      fechaRetiro: true,
      llegadaGpsAt: true,
      circuitoMin: true,
      rutaDuracionMin: true,
      compactadoId: true,
      compactadoOrden: true,
      estiloManejo: true,
      estiloCalculadoAt: true,
    },
  });

// Usuarios que manejan: choferes y cualquier otro usuario al que se le haya puesto nivel.
export const findDrivingUsers = () =>
  prisma.user.findMany({
    where: { estado: "ACTIVO", OR: [{ cargo: "CHOFER" }, { nivelChofer: { not: null } }] },
    select: { id: true, nombre: true, apellido: true, cargo: true, nivelChofer: true, grupo: true },
    orderBy: [{ nombre: "asc" }, { apellido: "asc" }],
  });
