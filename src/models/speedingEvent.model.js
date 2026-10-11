import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

// vehicleIds: null = sin restriccion (Admin); una lista = solo esos vehiculos (Responsable; vacia = ninguno).
const vehicleFilter = (vehicleIds) => (vehicleIds ? { vehicleId: { in: vehicleIds } } : {});
const sqlVehicleFilter = (vehicleIds) => (vehicleIds ? Prisma.sql`WHERE "vehicleId" IN (${Prisma.join(vehicleIds)})` : Prisma.empty);

// Evita una fila nueva cada 30-60s mientras el vehiculo sigue sobre el umbral - un
// exceso sostenido (o varios picos en pocos minutos) se agrupa como el mismo episodio.
export const findRecentEventForVehicle = (vehicleId, dedupMinutes) =>
  prisma.speedingEvent.findFirst({
    where: { vehicleId, occurredAt: { gte: new Date(Date.now() - dedupMinutes * 60 * 1000) } },
    select: { id: true },
  });

export const createSpeedingEvent = (vehicleId, targa, speedKmh, { driverId = null, recordId = null } = {}) =>
  prisma.speedingEvent.create({ data: { vehicleId, targa, speedKmh, driverId, recordId } });

// Los excesos del propio chofer (lo que le aparece a el en sus avisos).
export const findEventsForDriver = (driverId, since) =>
  prisma.speedingEvent.findMany({ where: { driverId, occurredAt: { gte: since } }, orderBy: { occurredAt: "desc" }, take: 20 });

// ---- Control de Flota: resumen liviano + detalle a pedido (acordeones) ----

// Una fila por dia de Roma (no UTC: un exceso a las 00:30 locales pertenece a ese dia) con
// cuantos excesos hubo, la maxima velocidad y cuantos vehiculos distintos. Son como mucho
// SPEEDING_EVENT_RETENTION_DAYS filas, sin traer ningun evento individual.
export const summarizeEventsByDay = (vehicleIds = null) =>
  vehicleIds?.length === 0
    ? []
    : prisma.$queryRaw`
    SELECT to_char(("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS count,
           MAX("speedKmh") AS "maxSpeedKmh",
           COUNT(DISTINCT "vehicleId")::int AS vehicles
    FROM speeding_events
    ${sqlVehicleFilter(vehicleIds)}
    GROUP BY 1
    ORDER BY 1 DESC`;

// Una fila por vehiculo, de mas a menos excesos (los reincidentes primero).
export const summarizeEventsByVehicle = (vehicleIds = null) =>
  vehicleIds?.length === 0
    ? []
    : prisma.$queryRaw`
    SELECT "vehicleId", MAX(targa) AS targa,
           COUNT(*)::int AS count,
           MAX("speedKmh") AS "maxSpeedKmh",
           MAX("occurredAt") AS "lastAt"
    FROM speeding_events
    ${sqlVehicleFilter(vehicleIds)}
    GROUP BY "vehicleId"
    ORDER BY count DESC, "lastAt" DESC`;

// Detalle de un dia (rango ya calculado en hora de Roma) o de un vehiculo: solo se pide
// cuando se abre el acordeon correspondiente. Tope por si algun dia se dispara.
export const findEventsInRange = ({ gte, lt }, vehicleIds = null) =>
  prisma.speedingEvent.findMany({
    where: { occurredAt: { gte, lt }, ...vehicleFilter(vehicleIds) },
    orderBy: { occurredAt: "desc" },
    take: 500,
  });

export const findEventsForVehicle = (vehicleId, vehicleIds = null) =>
  vehicleIds && !vehicleIds.includes(vehicleId)
    ? []
    : prisma.speedingEvent.findMany({ where: { vehicleId }, orderBy: { occurredAt: "desc" }, take: 500 });

// Retencion: a diferencia de AreaCEntry, no hay "pagado" que exceptuar - se poda todo
// lo viejo, sin excepciones.
export const deleteSpeedingEventsOlderThan = (cutoffDate) =>
  prisma.speedingEvent.deleteMany({ where: { occurredAt: { lt: cutoffDate } } });
