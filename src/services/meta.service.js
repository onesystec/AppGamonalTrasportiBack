import { getConfig, setConfig } from "../models/permiso.model.js";
import { findDoneRecordsForKm, findDrivingUsers } from "../models/meta.model.js";
import { kmRecorrido } from "../utils/kmFacturables.js";
import { AppError } from "../utils/AppError.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAVE = "metas.km";
const NIVELES = ["NOVATO", "MASTER", "SENIOR"];

const romeDay = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
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

// Mismo criterio de km que el pago: lo que reporto el chofer, si no el del servicio y, de ultima, el de la ruta.
const kmOf = (r) => kmRecorrido(r);

const resolveMonth = (month) => month ?? romeDay().slice(0, 7);

const windowFor = (month) => {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const [y, m] = month.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  // Un dia de margen a cada lado; despues se filtra por el dia de Roma.
  return { from: new Date(start.getTime() - DAY_MS), to: new Date(next.getTime() + DAY_MS) };
};

const kmByDriver = async (month, driverIds) => {
  const { from, to } = windowFor(month);
  const rows = await findDoneRecordsForKm({ from, to, driverIds });
  const totals = new Map();
  for (const r of rows) {
    if (!r.driverId || romeDay(r.fechaServicio).slice(0, 7) !== month) continue;
    const entry = totals.get(r.driverId) ?? { km: 0, servicios: 0 };
    entry.km += kmOf(r);
    entry.servicios += 1;
    totals.set(r.driverId, entry);
  }
  return totals;
};

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
  const [metas, totals] = await Promise.all([getMetasConfig(), kmByDriver(month, [actor.id])]);
  return progressOf(actor.nivelChofer, metas, totals.get(actor.id), month);
};

// Avance de todos los que manejan, para la oficina.
export const listDriversProgress = async (actor, query) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") {
    throw new AppError("No tienes permisos para realizar esta accion", 403);
  }
  const month = resolveMonth(query.month);
  const users = await findDrivingUsers();
  const [metas, totals] = await Promise.all([getMetasConfig(), kmByDriver(month, users.map((u) => u.id))]);
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
