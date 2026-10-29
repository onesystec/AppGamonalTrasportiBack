import { prisma } from "../config/prisma.js";
import { getVehicleDistanceKm, isOnesystecConfigured } from "./onesystec.service.js";
import { romeDay, romeLocalToDate } from "../utils/romeTime.js";

// Km de cada vehiculo contados solos con el GPS (Mecanica / Tagliando). A mano solo se carga el odometro del ultimo tagliando y su fecha: desde el
// dia siguiente se suman los km que el GPS (OneSystec) registro cada dia, y Vehiculo.kmActual = kmLecturaBase + esos km.
//  - Cada dia (hora de Roma) se pide UNA vez a OneSystec y se guarda en vehiculo_km_dias. Un dia que ya termino se da por cerrado (pasada una hora de
//    margen, por si el GPS manda puntos atrasados) y no se vuelve a pedir; el de hoy se refresca cada pocos minutos.
//  - El total solo se actualiza cuando estan TODOS los dias (si falta alguno por un corte del GPS o por el limite por vuelta, se conserva el ultimo valor y
//    se reintenta): un total a medias mostraria menos km de los reales.
//  - Un vehiculo que no esta en OneSystec queda en SIN_GPS y sigue con su KM actual a mano.
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = 60 * 60 * 1000;
const TODAY_TTL_MS = 10 * 60 * 1000;
const PAUSE_BETWEEN_CALLS_MS = 200;
export const MAX_CALLS_PER_SYNC = 40;

const dateToDay = (date) => date.toISOString().slice(0, 10);
const dayToDate = (day) => new Date(`${day}T00:00:00.000Z`);
const addDays = (day, n) => new Date(dayToDate(day).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const round1 = (value) => Math.round(value * 10) / 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const locks = new Set();

// Pone al dia los km de un vehiculo. Devuelve { estado, kmGps, pendientes, llamadas }: estado OK | SIN_GPS | ERROR | SIN_BASE | OCUPADO.
export const syncVehicleKm = async (vehicleId, { maxCalls = MAX_CALLS_PER_SYNC, forceToday = false, now = Date.now() } = {}) => {
  const vehicle = await prisma.vehiculo.findUnique({
    where: { id: vehicleId },
    select: { id: true, targa: true, kmLecturaBase: true, fechaLecturaBase: true },
  });
  if (!vehicle?.fechaLecturaBase || vehicle.kmLecturaBase == null) return { estado: "SIN_BASE", kmGps: 0, pendientes: 0, llamadas: 0 };
  if (!isOnesystecConfigured()) return { estado: "SIN_GPS", kmGps: 0, pendientes: 0, llamadas: 0 };
  if (locks.has(vehicleId)) return { estado: "OCUPADO", kmGps: 0, pendientes: 0, llamadas: 0 };
  locks.add(vehicleId);

  try {
    const base = dateToDay(vehicle.fechaLecturaBase);
    const today = romeDay(now);
    const rows = await prisma.vehiculoKmDia.findMany({ where: { vehiculoId: vehicleId, dia: { gt: vehicle.fechaLecturaBase, lte: dayToDate(today) } } });
    const byDay = new Map(rows.map((r) => [dateToDay(r.dia), r]));

    let estado = "OK";
    let llamadas = 0;
    for (let day = addDays(base, 1); day <= today; day = addDays(day, 1)) {
      const row = byDay.get(day);
      if (row?.cerrado) continue;
      if (day === today && row && !forceToday && now - row.actualizadoAt.getTime() < TODAY_TTL_MS) continue;
      if (llamadas >= maxCalls) continue;
      const from = romeLocalToDate(day, "00:00").getTime();
      const dayEnd = romeLocalToDate(addDays(day, 1), "00:00").getTime();
      try {
        // Hoy se pide hasta ahora; un dia que ya paso, entero.
        const km = await getVehicleDistanceKm(vehicle.targa, from, Math.min(dayEnd, now));
        if (km === null) {
          estado = "SIN_GPS";
          break;
        }
        llamadas += 1;
        const saved = await prisma.vehiculoKmDia.upsert({
          where: { vehiculoId_dia: { vehiculoId: vehicleId, dia: dayToDate(day) } },
          create: { vehiculoId: vehicleId, dia: dayToDate(day), km, cerrado: now >= dayEnd + SETTLE_MS },
          update: { km, cerrado: now >= dayEnd + SETTLE_MS },
        });
        byDay.set(day, saved);
        await sleep(PAUSE_BETWEEN_CALLS_MS);
      } catch (err) {
        console.error(`[km-gps] ${vehicle.targa} ${day}:`, err.message);
        estado = "ERROR";
        break;
      }
    }

    // Con todos los dias (o SIN_GPS) se puede dar el total; si falta alguno, se conserva el ultimo valor y se reintenta.
    const faltan = countMissing(byDay, base, today);
    const completo = estado === "OK" && faltan === 0;
    const kmGps = [...byDay.values()].reduce((sum, r) => sum + r.km, 0);

    if (estado === "SIN_GPS") {
      await prisma.vehiculo.update({ where: { id: vehicleId }, data: { kmGpsEstado: "SIN_GPS", kmGpsActualizadoAt: new Date(now) } });
    } else if (completo) {
      await prisma.vehiculo.update({
        where: { id: vehicleId },
        data: { kmActual: round1(vehicle.kmLecturaBase + kmGps), kmGpsEstado: "OK", kmGpsActualizadoAt: new Date(now) },
      });
    } else {
      await prisma.vehiculo.update({ where: { id: vehicleId }, data: { kmGpsEstado: estado === "ERROR" ? "ERROR" : "PENDIENTE" } });
    }
    return { estado: completo ? "OK" : estado === "OK" ? "PENDIENTE" : estado, kmGps: round1(kmGps), pendientes: faltan, llamadas };
  } finally {
    locks.delete(vehicleId);
  }
};

const countMissing = (byDay, base, today) => {
  let missing = 0;
  for (let day = addDays(base, 1); day <= today; day = addDays(day, 1)) if (!byDay.has(day)) missing += 1;
  return missing;
};

// Todos los vehiculos con tagliando cargado con fecha (los que cuentan con GPS): una vuelta de la tarea de fondo.
export const syncAllVehiclesKm = async ({ maxCallsTotal = 120 } = {}) => {
  const vehicles = await prisma.vehiculo.findMany({
    where: { fechaLecturaBase: { not: null }, kmLecturaBase: { not: null } },
    select: { id: true, targa: true },
    orderBy: { targa: "asc" },
  });
  let left = maxCallsTotal;
  const result = [];
  for (const v of vehicles) {
    if (left <= 0) break;
    const r = await syncVehicleKm(v.id, { maxCalls: Math.min(MAX_CALLS_PER_SYNC, left) });
    left -= r.llamadas;
    result.push({ targa: v.targa, ...r });
  }
  return result;
};
