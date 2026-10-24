import { getConfig, setConfig } from "../models/permiso.model.js";
import { findDrivingUsers } from "../models/meta.model.js";
import { getPaidKmByDriver } from "./finanzas.service.js";
import { AppError } from "../utils/AppError.js";
import { romeDay } from "../utils/romeTime.js";

const CLAVE = "metas.km";
const NIVELES = ["NOVATO", "MASTER", "SENIOR"];

const round1 = (value) => Math.round(value * 10) / 10;
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// Metas mensuales de km por nivel: { NOVATO: 1800, MASTER: null, SENIOR: null }. null = sin definir.
export const getMetasConfig = async () => {
  const row = await getConfig(CLAVE);
  const saved = row?.valor ?? {};
  return Object.fromEntries(NIVELES.map((nivel) => [nivel, typeof saved[nivel] === "number" ? saved[nivel] : null]));
};

export const setMetasConfig = async (values) => {
  const next = Object.fromEntries(NIVELES.map((nivel) => [nivel, values[nivel] ?? null]));
  await setConfig(CLAVE, next);
  return next;
};

const resolveMonth = (month) => month ?? romeDay().slice(0, 7);

// Los mismos km que se pagan (circuito del sistema o km reales del chofer) y que muestra el ranking.
const kmByDriver = (month, driverId) => getPaidKmByDriver(month, { driverId });

const progressOf = (nivel, metas, entry, month) => {
  const meta = nivel ? (metas[nivel] ?? null) : null;
  const km = round1(entry?.km ?? 0);
  return {
    nivel: nivel ?? null,
    meta,
    km,
    servicios: entry?.servicios ?? 0,
    porcentaje: meta ? Math.min(999, Math.round((km / meta) * 100)) : null,
    faltan: meta ? Math.max(0, round1(meta - km)) : null,
    cumplida: meta ? km >= meta : false,
    month,
  };
};

// Avance del mes de quien consulta (cualquier usuario que maneja).
export const getMyProgress = async (actor, query) => {
  const month = resolveMonth(query.month);
  const [metas, totals] = await Promise.all([getMetasConfig(), kmByDriver(month, actor.id)]);
  return progressOf(actor.nivelChofer, metas, totals.get(actor.id), month);
};

// Avance de todos los que manejan, para la oficina.
export const listDriversProgress = async (actor, query) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") {
    throw new AppError("No tienes permisos para realizar esta accion", 403);
  }
  const month = resolveMonth(query.month);
  const users = await findDrivingUsers();
  const [metas, totals] = await Promise.all([getMetasConfig(), kmByDriver(month)]);
  return {
    month,
    metas,
    items: users.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      apellido: u.apellido,
      cargo: u.cargo,
      ...progressOf(u.nivelChofer, metas, totals.get(u.id), month),
    })),
  };
};
