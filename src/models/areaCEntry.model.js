import { prisma } from "../config/prisma.js";
import { buildLocalDateRange } from "../utils/dateRange.js";

// El Area C de Milano se paga por DIA completo (un ticket cubre todas las entradas de
// ese dia), no por entrada individual - si ya hay un registro de este vehiculo hoy
// (hora local Europe/Rome, no la del servidor), no hace falta uno nuevo aunque haya
// salido y vuelto a entrar.
export const findTodayEntryForVehicle = (vehicleId) => {
  const [year, month, day] = new Date()
    .toLocaleDateString("en-CA", { timeZone: "Europe/Rome" })
    .split("-")
    .map(Number);
  const { gte, lt } = buildLocalDateRange(year, month, day, "Europe/Rome");

  return prisma.areaCEntry.findFirst({
    where: { vehicleId, enteredAt: { gte, lt } },
    select: { id: true },
  });
};

export const createAreaCEntry = (vehicleId, targa) =>
  prisma.areaCEntry.create({ data: { vehicleId, targa } });

export const findEntryById = (id) => prisma.areaCEntry.findUnique({ where: { id } });

export const updateEntryById = (id, data) => prisma.areaCEntry.update({ where: { id }, data });

// Seccion "Area C" del Mapa (pestanias Pagado/No pagado) - se pide una sola lista, el
// front separa por "pagado". Tope de 200 mas que de sobra: las pagadas se acumulan
// lento (una por vehiculo por dia como mucho) y las no pagadas se podan solas.
export const findAllEntries = () =>
  prisma.areaCEntry.findMany({ where: { descartada: false }, orderBy: { enteredAt: "desc" }, take: 200 });

// Para la campanita de notificaciones: solo las que siguen sin pagar - una vez pagada,
// deja de tener sentido seguir avisando (ver computeAreaCAlerts en el front).
export const findUnpaidEntries = () =>
  prisma.areaCEntry.findMany({ where: { pagado: false, descartada: false }, orderBy: { enteredAt: "desc" } });

// Retencion (ver AREA_C_ENTRY_RETENTION_DAYS en env.js) - solo lo que sigue SIN pagar:
// una vez pagada (con o sin comprobante) la entrada queda como registro permanente,
// nunca se borra sola.
export const findUnpaidEntriesOlderThan = (cutoffDate) =>
  prisma.areaCEntry.findMany({
    where: { pagado: false, enteredAt: { lt: cutoffDate } },
    select: { id: true, comprobanteKey: true },
  });

// Filas "eliminadas" de dias anteriores: ya no hace falta conservarlas (solo servian para
// que el chequeo del dia no recreara la entrada).
export const findDiscardedEntriesOlderThan = (cutoffDate) =>
  prisma.areaCEntry.findMany({
    where: { descartada: true, enteredAt: { lt: cutoffDate } },
    select: { id: true, comprobanteKey: true },
  });

export const deleteAreaCEntryById = (id) => prisma.areaCEntry.delete({ where: { id } });

export const deleteAreaCEntriesByIds = (ids) =>
  prisma.areaCEntry.deleteMany({ where: { id: { in: ids } } });
