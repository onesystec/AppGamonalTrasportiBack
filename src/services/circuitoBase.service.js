import { prisma } from "../config/prisma.js";
import { ensureCircuitSafe } from "./rutaEstimada.service.js";

// Circuito estandar (base de los km que se pagan en traspasos, viajes compactados y servicios sin km planificados; siempre con peajes) de los servicios cuyo circuito se calculo evitando peajes porque el chofer declaro "sin peaje":
// la migracion copia el circuito donde no hubo declaracion y aqui se recalcula el resto, una sola vez al arrancar. Desde la tarifa con pago por km
// (octubre de 2026). De a uno y con pausa: las rutas salen de servidores publicos. Lo que no se pueda calcular (paradas sin ubicar) se reintenta
// en el proximo arranque; mientras tanto el pago usa el circuito que ya tenia.
const DESDE = new Date("2026-10-01T00:00:00.000Z");
const PAUSA_MS = 1500;
const MAX_POR_VUELTA = 500;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const recalcularCircuitosBase = async () => {
  const pendientes = await prisma.record.findMany({
    where: { circuitoKm: { not: null }, circuitoKmBase: null, fechaServicio: { gte: DESDE } },
    select: { id: true },
    orderBy: { fechaServicio: "desc" },
    take: MAX_POR_VUELTA,
  });
  let hechos = 0;
  for (const { id } of pendientes) {
    const circuito = await ensureCircuitSafe(id);
    if (circuito) hechos += 1;
    await dormir(PAUSA_MS);
  }
  if (pendientes.length) console.log(`[circuito-base] ${hechos} de ${pendientes.length} circuito(s) recalculados con la ruta estandar`);
  return { pendientes: pendientes.length, hechos };
};
