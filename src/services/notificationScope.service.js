import { prisma } from "../config/prisma.js";
import { recordAreaKey, recordAreaWhere } from "../utils/areaAccess.js";

// A quien le llega cada aviso de gestion (documentos, tagliando, Area C, permisos...).
//  - Admin (OWNER): todo.
//  - Responsable (ADMIN): solo lo de su asignacion. Un vehiculo o un chofer es suyo si trabajo en los servicios de sus areas
//    (User.areasPermitidas) en los ultimos 60 dias, o si es de su mismo grupo/centro (Milano Sud, Milano Nord, Farmacia...).
//  - Chofer: no recibe avisos de gestion; solo los de lo suyo (eso se arma aparte).
const RECENT_MS = 60 * 24 * 60 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;

const cache = new Map();

export const invalidateScopeCache = () => cache.clear();

const unique = (values) => [...new Set(values.filter(Boolean))];

// null = sin restriccion (Admin). Para un Responsable: { vehicleIds, driverIds }.
export const getOfficeScope = async (actor) => {
  if (!actor || actor.cargo !== "ADMIN") return null;
  const hit = cache.get(actor.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const since = new Date(Date.now() - RECENT_MS);
  const areaWhere = recordAreaWhere(actor);
  const [usedVehicles, usedDrivers, groupVehicles, groupDrivers] = await Promise.all([
    prisma.record.findMany({ where: { fechaServicio: { gte: since }, ...areaWhere }, distinct: ["vehicleId"], select: { vehicleId: true } }),
    prisma.record.findMany({ where: { fechaServicio: { gte: since }, ...areaWhere }, distinct: ["driverId"], select: { driverId: true } }),
    actor.grupo ? prisma.vehiculo.findMany({ where: { grupo: actor.grupo }, select: { id: true } }) : [],
    actor.grupo ? prisma.user.findMany({ where: { grupo: actor.grupo, cargo: "CHOFER" }, select: { id: true } }) : [],
  ]);
  const value = {
    vehicleIds: unique([...usedVehicles.map((r) => r.vehicleId), ...groupVehicles.map((v) => v.id)]),
    driverIds: unique([...usedDrivers.map((r) => r.driverId), ...groupDrivers.map((u) => u.id)]),
  };
  cache.set(actor.id, { at: Date.now(), value });
  return value;
};

// Areas de servicio en las que trabajo un vehiculo / chofer en los ultimos 60 dias.
const recentAreaKeys = async (where) => {
  const rows = await prisma.record.findMany({
    where: { ...where, fechaServicio: { gte: new Date(Date.now() - RECENT_MS) } },
    distinct: ["spedizzione", "extrasPiazzaZona"],
    select: { spedizzione: true, extrasPiazzaZona: true },
  });
  return unique(rows.map(recordAreaKey));
};

const ownerIds = async () => (await prisma.user.findMany({ where: { cargo: "OWNER", estado: "ACTIVO" }, select: { id: true } })).map((u) => u.id);

// Admin activos + los Responsables activos a los que les corresponde (misma area de servicio o mismo grupo).
const officeIdsFor = async ({ areaKeys, grupo }) => {
  const or = [];
  if (areaKeys.length) or.push({ areasPermitidas: { hasSome: areaKeys } });
  if (grupo) or.push({ grupo });
  const [owners, responsables] = await Promise.all([
    ownerIds(),
    or.length ? prisma.user.findMany({ where: { cargo: "ADMIN", estado: "ACTIVO", OR: or }, select: { id: true } }) : [],
  ]);
  return unique([...owners, ...responsables.map((u) => u.id)]);
};

export const findOfficeUserIdsForVehicle = async (vehicleId) => {
  const [areaKeys, vehicle] = await Promise.all([
    recentAreaKeys({ vehicleId }),
    prisma.vehiculo.findUnique({ where: { id: vehicleId }, select: { grupo: true } }),
  ]);
  return officeIdsFor({ areaKeys, grupo: vehicle?.grupo ?? null });
};

export const findOfficeUserIdsForDriver = async (driverId) => {
  const [areaKeys, driver] = await Promise.all([
    recentAreaKeys({ driverId }),
    prisma.user.findUnique({ where: { id: driverId }, select: { grupo: true } }),
  ]);
  return officeIdsFor({ areaKeys, grupo: driver?.grupo ?? null });
};

// Avisos de toda la flota que no son de ningun area (como el estado del GPS): el Admin y todos los Responsables activos.
export const findAllOfficeUserIds = async () =>
  (await prisma.user.findMany({ where: { cargo: { in: ["OWNER", "ADMIN"] }, estado: "ACTIVO" }, select: { id: true } })).map((u) => u.id);
