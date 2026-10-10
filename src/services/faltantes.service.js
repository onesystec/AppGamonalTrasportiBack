import { FALTANTES_DESDE } from "../config/faltantes.js";
import { findFinishedForVehicles, findFuelForVehicles, findRecordsToRemind, markRemindedByIds } from "../models/faltantes.model.js";
import { groupMancatosByRecord } from "../models/mancato.model.js";
import { computeFaltantes, estimateLiters, isEvaluable, romeDay } from "../utils/faltantes.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (vehicleId, day) => `${vehicleId}|${day}`;

// Datos para evaluar un grupo de servicios: peajes asignados por tramo y, por vehiculo y dia, los litros
// estimados de todos sus servicios, los comprobantes de combustible y si alguien declaro "no fue necesario".
// Deja el resultado en cada servicio (faltantesCounts / faltantesDay) para que computeFaltantes lo use.
export const attachFaltantes = async (records) => {
  const evaluables = records.filter((r) => r.vehicleId && isEvaluable(r));
  const mancatoGroups = evaluables.length > 0 ? await groupMancatosByRecord() : [];
  const mancatosByRecord = new Map();
  for (const g of mancatoGroups) {
    const entry = mancatosByRecord.get(g.recordId) ?? { mancatoIda: 0, mancatoVuelta: 0, mancatoSinTramo: 0 };
    if (g.tramo === "IDA") entry.mancatoIda += g._count._all;
    else if (g.tramo === "VUELTA") entry.mancatoVuelta += g._count._all;
    else entry.mancatoSinTramo += g._count._all;
    mancatosByRecord.set(g.recordId, entry);
  }

  const days = new Map();
  if (evaluables.length > 0) {
    const vehicleIds = [...new Set(evaluables.map((r) => r.vehicleId))];
    const times = evaluables.map((r) => new Date(r.fechaServicio).getTime());
    const gte = new Date(Math.min(...times) - DAY_MS);
    const lt = new Date(Math.max(...times) + 2 * DAY_MS);
    const [finished, fuel] = await Promise.all([
      findFinishedForVehicles({ vehicleIds, gte, lt }),
      findFuelForVehicles({ vehicleIds, gte, lt }),
    ]);
    const entryOf = (key) => {
      if (!days.has(key)) days.set(key, { litros: 0, servicios: 0, comprobantes: 0, declarado: false });
      return days.get(key);
    };
    for (const r of finished) {
      const entry = entryOf(dayKey(r.vehicleId, romeDay(r.fechaServicio)));
      entry.servicios += 1;
      entry.litros += estimateLiters(r)?.medio ?? 0;
      if (r.sinCombustible) entry.declarado = true;
    }
    for (const f of fuel) entryOf(dayKey(f.vehicleId, f.fecha.toISOString().slice(0, 10))).comprobantes += 1;
  }

  for (const record of records) {
    record.faltantesCounts = {
      ...(mancatosByRecord.get(record.id) ?? { mancatoIda: 0, mancatoVuelta: 0, mancatoSinTramo: 0 }),
      combustibles: record.combustibles ? record.combustibles.length : (record.fuelCount ?? 0),
    };
    record.faltantesDay = record.vehicleId ? (days.get(dayKey(record.vehicleId, romeDay(record.fechaServicio))) ?? null) : null;
  }
  return records;
};

// ---------------------------------------------------------------- aviso al chofer

const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

// Un servicio terminado que lleva mas de 24 horas con faltantes: se avisa una sola vez por servicio, con
// un solo mensaje por chofer. Devuelve cuantos servicios y choferes se avisaron.
export const remindDriversOfFaltantes = async () => {
  const since = new Date(`${FALTANTES_DESDE}T00:00:00Z`);
  const records = await findRecordsToRemind({ gte: new Date(since.getTime() - DAY_MS), lt: new Date(Date.now() + DAY_MS) });
  await attachFaltantes(records);

  const byDriver = new Map();
  for (const record of records) {
    const endedAt = new Date(record.horaFinReal ?? record.eta ?? record.fechaServicio).getTime();
    if (Date.now() - endedAt < REMIND_AFTER_MS) continue;
    const faltantes = computeFaltantes(record, record.faltantesCounts, record.faltantesDay);
    if (faltantes.pendientes === 0) continue;
    const list = byDriver.get(record.driverId) ?? [];
    list.push(record);
    byDriver.set(record.driverId, list);
  }

  for (const [driverId, list] of byDriver) {
    const n = list.length;
    await sendPushToUserIds([driverId], {
      title: "Servicios con peajes o carburante sin declarar",
      body: `Tienes ${n} servicio${n === 1 ? "" : "s"} sin declarar peajes o carburante. Subelos o activa el switch si no hubo.`,
      data: { type: "faltantes" },
    }).catch(() => {});
    await markRemindedByIds(list.map((r) => r.id));
  }
  return { servicios: [...byDriver.values()].reduce((sum, l) => sum + l.length, 0), choferes: byDriver.size };
};
