import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { recordAreaWhere } from "../utils/areaAccess.js";
import { romeDay } from "../utils/romeTime.js";

// Disponibilidad de choferes y vehiculos dia por dia ("Disponibilita").
//  - Choferes: los permisos, enfermedad, vacaciones y descansos APROBADOS (y los permisos todavia en revision, marcados aparte) de su calendario, mas los
//    dias en que tienen servicios.
//  - Vehiculos: los dias en que tienen servicios y, si estan en mantenimiento o fuera de servicio, todos los dias (la ficha solo guarda el estado de hoy,
//    no hasta cuando dura).
// Devuelve solo los dias con algo (mapa disperso): lo que no esta, esta libre.
const MAX_DAYS = 62;
const DEFAULT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Servicios que ocupan al chofer y al vehiculo ese dia (un anulado o reprogramado no).
const BUSY_ESTADOS = ["IN_SOSPESO", "IN_CONSEGNA", "RITIRATO", "CONSEGNATO"];

const addDays = (day, n) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const dateToDay = (date) => date.toISOString().slice(0, 10);
const daysBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

const person = (u) => ({ id: u.id, nombre: `${u.nombre} ${u.apellido}`.trim() });

export const getDisponibilidadForActor = async (actor, { desde, hasta } = {}) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") throw new AppError("No autorizado", 403);
  const today = romeDay();
  const from = desde ?? today;
  const to = hasta ?? addDays(from, DEFAULT_DAYS - 1);
  if (to < from) throw new AppError("El rango de fechas no es valido", 400);
  const dias = daysBetween(from, to);
  if (dias.length > MAX_DAYS) throw new AppError(`Maximo ${MAX_DAYS} dias por consulta`, 400);
  const inRange = new Set(dias);

  // Un dia de margen a cada lado: el limite del dia de Roma cae unas horas fuera del de UTC.
  const windowFrom = new Date(new Date(`${from}T00:00:00.000Z`).getTime() - DAY_MS);
  const windowTo = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 2 * DAY_MS);

  const [drivers, vehicles, permisos, records] = await Promise.all([
    prisma.user.findMany({
      where: { cargo: "CHOFER", estado: "ACTIVO" },
      select: { id: true, nombre: true, apellido: true },
      orderBy: [{ nombre: "asc" }, { apellido: "asc" }],
    }),
    // Los que no se ven en el Mapa son los que se importaron solos del GPS (de otras empresas): aparecen solo si tienen servicios.
    prisma.vehiculo.findMany({
      select: { id: true, targa: true, modelo: true, estado: true, mostrarEnMapa: true },
      orderBy: { targa: "asc" },
    }),
    prisma.permiso.findMany({
      where: {
        estado: { in: ["APROBADO", "PENDIENTE"] },
        fechaDesde: { lte: new Date(`${to}T00:00:00.000Z`) },
        fechaHasta: { gte: new Date(`${from}T00:00:00.000Z`) },
        driver: { cargo: "CHOFER", estado: "ACTIVO" },
      },
      select: { driverId: true, tipo: true, estado: true, fechaDesde: true, fechaHasta: true },
    }),
    prisma.record.findMany({
      where: {
        estado: { in: BUSY_ESTADOS },
        OR: [{ fechaServicio: { gte: windowFrom, lt: windowTo } }, { eta: { gte: windowFrom, lt: windowTo } }],
        ...(recordAreaWhere(actor) ?? {}),
      },
      select: {
        codigo: true,
        driverId: true,
        vehicleId: true,
        fechaServicio: true,
        fechaRetiro: true,
        eta: true,
        destinazione: true,
        driver: { select: { id: true, nombre: true, apellido: true, cargo: true, estado: true } },
      },
    }),
  ]);

  const choferes = new Map(drivers.map((d) => [d.id, { ...person(d), dias: {} }]));
  const conServicios = new Set(records.map((r) => r.vehicleId));
  const vehiculos = new Map(
    vehicles.filter((v) => v.mostrarEnMapa || conServicios.has(v.id)).map((v) => [v.id, { id: v.id, nombre: v.targa, modelo: v.modelo, estado: v.estado, visible: v.mostrarEnMapa, dias: {} }])
  );
  const push = (entry, day, item) => {
    if (!entry || !inRange.has(day)) return;
    (entry.dias[day] ??= []).push(item);
  };

  for (const p of permisos) {
    const entry = choferes.get(p.driverId);
    const first = dateToDay(p.fechaDesde) < from ? from : dateToDay(p.fechaDesde);
    const last = dateToDay(p.fechaHasta) > to ? to : dateToDay(p.fechaHasta);
    for (const day of daysBetween(first, last)) push(entry, day, { tipo: p.tipo, pendiente: p.estado === "PENDIENTE" });
  }

  for (const r of records) {
    // Un servicio ocupa del dia de su salida al dia de su llegada (uno que cruza la medianoche ocupa los dos).
    const start = romeDay(r.fechaRetiro ?? r.fechaServicio);
    const end = romeDay(r.eta) >= start ? romeDay(r.eta) : start;
    const item = { tipo: "SERVICIO", codigo: r.codigo, destino: r.destinazione };
    // Un Admin o Owner que tambien maneja aparece solo si tiene servicios en el rango.
    if (r.driver && !choferes.has(r.driverId) && r.driver.estado === "ACTIVO") choferes.set(r.driverId, { ...person(r.driver), dias: {} });
    for (const day of daysBetween(start, end)) {
      push(choferes.get(r.driverId), day, item);
      push(vehiculos.get(r.vehicleId), day, item);
    }
  }

  for (const v of vehiculos.values()) {
    if (v.estado === "DISPONIBLE") continue;
    for (const day of dias) (v.dias[day] ??= []).push({ tipo: v.estado === "EN_MANTENIMIENTO" ? "MANTENIMIENTO" : "FUERA_DE_SERVICIO" });
  }

  const byName = (a, b) => a.nombre.localeCompare(b.nombre, "es");
  return {
    desde: from,
    hasta: to,
    hoy: today,
    dias,
    choferes: [...choferes.values()].sort(byName),
    vehiculos: [...vehiculos.values()].sort(byName),
  };
};
