import { prisma } from "../config/prisma.js";
import { PAY_TARIFFS } from "../config/payRates.js";
import { bumpCacheVersion } from "../utils/responseCache.js";
import { AppError } from "../utils/AppError.js";

// Velocidad de pago de cada chofer (km/h con los que se pasan los km a horas de manejo). Se elige por chofer y por mes en Pago a
// choferes; el valor rige desde ese mes y se hereda en los siguientes. Sin ningun valor, rige el de la tarifa (85).
// Como la tabla es chica y el pago se calcula en muchos lugares de forma sincrona, se guarda en memoria (se recarga cada
// CACHE_TTL_MS y en cuanto se cambia algo). Quien calcula pagos llama antes a ensureKmhPago().

export const VELOCIDADES_PAGO = [85, 90, 95];
const CACHE_TTL_MS = 30 * 1000;

// Primer mes con pago por km: antes no se usa este valor (esos meses ya estan pagados con 100 km).
const PRIMER_MES = PAY_TARIFFS.find((t) => t.pagoPorKm)?.desde ?? "2026-10";

let byDriver = new Map(); // driverId -> [{ mes, kmh }] ordenado por mes
let conPagoAparte = new Set(); // choferes con el pago aparte del basico (fuera de horario y reperibilita) activado
let loadedAt = 0;
let loading = null;

const load = async () => {
  const rows = await prisma.velocidadPagoChofer.findMany({ select: { driverId: true, mes: true, kmh: true }, orderBy: { mes: "asc" } });
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.driverId)) map.set(row.driverId, []);
    map.get(row.driverId).push({ mes: row.mes, kmh: row.kmh });
  }
  byDriver = map;
  // Interruptor "pago aparte" de Pago a choferes (User.pagoAparte): solo se guardan los que lo tienen activado.
  const con = await prisma.user.findMany({ where: { pagoAparte: true }, select: { id: true } });
  conPagoAparte = new Set(con.map((u) => u.id));
  loadedAt = Date.now();
};

// true = el trabajo fuera del horario laboral (noche, fin de semana, festivo) y la reperibilita se muestran y pagan APARTE del basico de este chofer.
export const pagoAparteFor = (driverId) => conPagoAparte.has(driverId);

// Interruptor "pago aparte" de un chofer (Pago a choferes, solo el Admin). No cambia el importe: solo si lo de fuera de horario va aparte o junto.
export const setPagoAparteForActor = async (actor, { driverId, activo }) => {
  if (actor.cargo !== "OWNER") throw new AppError("Solo un Admin puede activar el pago aparte", 403);
  const driver = await prisma.user.findUnique({ where: { id: driverId }, select: { id: true } });
  if (!driver) throw new AppError("Chofer no encontrado", 404);
  await prisma.user.update({ where: { id: driverId }, data: { pagoAparte: activo } });
  await ensureKmhPago({ force: true });
  bumpCacheVersion();
  return { driverId, activo };
};

// Un fallo al leer la tabla no frena los pagos: sigue con lo que ya se tenia (o con el valor de la tarifa).
export const ensureKmhPago = async ({ force = false } = {}) => {
  if (!force && Date.now() - loadedAt < CACHE_TTL_MS) return;
  loading ??= load()
    .catch((err) => console.error("[velocidadPago] no se pudo leer:", err.message))
    .finally(() => {
      loading = null;
    });
  await loading;
};

// Velocidad que rige para un chofer en un mes ("AAAA-MM"): la ultima elegida desde ese mes o antes. null = la de la tarifa.
export const kmhPagoFor = (driverId, month) => {
  const rows = byDriver.get(driverId);
  if (!rows || !month) return null;
  let found = null;
  for (const row of rows) if (row.mes <= month) found = row;
  return found?.kmh ?? null;
};

// Lo que se le muestra a la oficina: el valor vigente y si se eligio en ese mismo mes o se hereda.
export const kmhPagoInfo = (driverId, month, defaultKmh) => {
  const rows = byDriver.get(driverId) ?? [];
  const valor = kmhPagoFor(driverId, month) ?? defaultKmh;
  return { valor, propio: rows.some((row) => row.mes === month) };
};

export const setKmhPagoForActor = async (actor, { driverId, month, kmh }) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") throw new AppError("No autorizado", 403);
  if (!VELOCIDADES_PAGO.includes(kmh)) throw new AppError(`La velocidad tiene que ser ${VELOCIDADES_PAGO.join(", ")} km/h`, 400);
  if (month < PRIMER_MES) throw new AppError("Antes de octubre de 2026 no se paga por km: no se puede cambiar", 400);
  const driver = await prisma.user.findUnique({ where: { id: driverId }, select: { id: true } });
  if (!driver) throw new AppError("Chofer no encontrado", 404);

  await prisma.velocidadPagoChofer.upsert({
    where: { driverId_mes: { driverId, mes: month } },
    create: { driverId, mes: month, kmh, cambiadoPorId: actor.id },
    update: { kmh, cambiadoPorId: actor.id },
  });
  await ensureKmhPago({ force: true });
  // Los resumenes en cache llevan el pago viejo.
  bumpCacheVersion();
  return { driverId, month, kmh };
};
