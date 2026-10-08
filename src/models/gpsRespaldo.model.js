import { prisma } from "../config/prisma.js";

const HOUR_MS = 60 * 60 * 1000;
const ACTIVE_ESTADOS = ["IN_SOSPESO", "RITIRATO", "IN_CONSEGNA"];

// Un servicio "en curso" para el respaldo: aun sin entregar (de las ultimas 24 h o de las proximas 8 h),
// o ya entregado pero sin horas cargadas (el chofer sigue volviendo y esa vuelta tambien se mide).
const activeServiceWhere = (now) => ({
  OR: [
    { estado: { in: ACTIVE_ESTADOS }, fechaServicio: { gte: new Date(now - 24 * HOUR_MS), lte: new Date(now + 8 * HOUR_MS) } },
    { estado: "CONSEGNATO", horasEstado: null, fechaServicio: { gte: new Date(now - 18 * HOUR_MS) } },
  ],
});

export const hasActiveService = async (driverId, now = Date.now()) =>
  Boolean(await prisma.record.findFirst({ where: { driverId, ...activeServiceWhere(now) }, select: { id: true } }));

// Choferes que autorizaron el respaldo y tienen un servicio en curso (a ellos se les avisa).
export const findChoferIdsWithConsentAndService = async (now = Date.now()) => {
  const users = await prisma.user.findMany({
    where: {
      cargo: "CHOFER",
      estado: "ACTIVO",
      gpsRespaldoPermitido: true,
      records: { some: activeServiceWhere(now) },
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
};

export const countChoferesConPermiso = async () => {
  const [conPermiso, total] = await Promise.all([
    prisma.user.count({ where: { cargo: "CHOFER", estado: "ACTIVO", gpsRespaldoPermitido: true } }),
    prisma.user.count({ where: { cargo: "CHOFER", estado: "ACTIVO" } }),
  ]);
  return { conPermiso, total };
};

export const createRespaldoPing = (driverId, lat, lng) =>
  prisma.locationPing.create({ data: { driverId, lat, lng, respaldo: true } });

export const findLastRespaldoPing = (driverId) =>
  prisma.locationPing.findFirst({
    where: { driverId, respaldo: true },
    orderBy: { recordedAt: "desc" },
    select: { lat: true, lng: true, recordedAt: true },
  });

// Posiciones de respaldo de un chofer entre dos instantes, con la misma forma que las del GPS del vehiculo.
export const findRespaldoPings = async (driverId, gte, lt) => {
  const rows = await prisma.locationPing.findMany({
    where: { driverId, respaldo: true, recordedAt: { gte, lt } },
    orderBy: { recordedAt: "asc" },
    select: { lat: true, lng: true, recordedAt: true },
  });
  return rows.map((r) => ({ at: r.recordedAt, lat: r.lat, lng: r.lng, speed: null, ignition: null, moving: null }));
};
