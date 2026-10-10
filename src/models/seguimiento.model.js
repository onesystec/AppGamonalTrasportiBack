import { prisma } from "../config/prisma.js";

const SELECT = {
  id: true,
  codigo: true,
  estado: true,
  eta: true,
  fechaRetiro: true,
  llegadaGpsAt: true,
  fechaServicio: true,
  destinazione: true,
  spedizzione: true,
  extrasPiazzaZona: true,
  compactadoId: true,
  compactadoOrden: true,
  salidaDireccion: true,
  salidaLat: true,
  salidaLng: true,
  driverId: true,
  driver: { select: { id: true, nombre: true, apellido: true, numeroCelular: true } },
  vehicle: { select: { id: true, targa: true } },
  client: { select: { nombre: true } },
  stops: { orderBy: { orden: "asc" }, select: { orden: true, direccion: true, lat: true, lng: true } },
};

// Servicios en camino (o ya retirados) en una ventana alrededor de ahora: un servicio que arranco de noche o
// que se alargo sigue contando. Los traspasos (continuaciones) son servicios propios, con su chofer.
export const findActiveForSeguimiento = ({ estados, gte, lte, areaWhere }) =>
  prisma.record.findMany({
    where: { estado: { in: estados }, fechaServicio: { gte, lte }, ...(areaWhere ?? {}) },
    select: SELECT,
    orderBy: { eta: "asc" },
  });

// Todos los servicios de los viajes compactados indicados (incluidos los ya entregados, para la linea de tiempo).
export const findGroupMembers = (compactadoIds) =>
  compactadoIds.length
    ? prisma.record.findMany({
        where: { compactadoId: { in: compactadoIds } },
        select: SELECT,
        orderBy: [{ compactadoId: "asc" }, { compactadoOrden: "asc" }],
      })
    : [];

// Hora en que el GPS vio al vehiculo en la parada final del servicio.
export const markLlegadaGps = (id, at) => prisma.record.update({ where: { id }, data: { llegadaGpsAt: at }, select: { id: true } });
