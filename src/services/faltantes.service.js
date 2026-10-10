import { FALTANTES_DESDE } from "../config/faltantes.js";
import { findFinishedForVehicles, findFuelForVehicles, findRecordsForUnsupported } from "../models/faltantes.model.js";
import { groupMancatosByRecord } from "../models/mancato.model.js";
import { attachCompactados } from "./compactadoView.service.js";
import { computeFaltantes, estimateLiters, isEvaluable, romeDay } from "../utils/faltantes.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (vehicleId, day) => `${vehicleId}|${day}`;

// Datos para evaluar un grupo de servicios: peajes asignados por tramo y, por vehiculo y dia, los litros
// estimados de todos sus servicios, los comprobantes de combustible y si alguien declaro "no fue necesario".
// Deja el resultado en cada servicio (faltantesCounts / faltantesDay) para que computeFaltantes lo use.
export const attachFaltantes = async (records) => {
  // Los servicios compactados en un viaje se evaluan juntos: el principal declara por todo el viaje.
  await attachCompactados(records);
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
    const members = record.compactadoMembers;
    if (members?.length) {
      if (record.id !== members[0].id) record.faltantesMiembro = true;
      else {
        const g = { mancatoIda: 0, mancatoVuelta: 0, mancatoSinTramo: 0, combustibles: 0, sinPeajeIda: false, sinPeajeVuelta: false, sinCombustible: false };
        for (const m of members) {
          const c = mancatosByRecord.get(m.id);
          if (c) {
            g.mancatoIda += c.mancatoIda;
            g.mancatoVuelta += c.mancatoVuelta;
            g.mancatoSinTramo += c.mancatoSinTramo;
          }
          g.combustibles += m._count?.combustibles ?? 0;
          g.sinPeajeIda ||= Boolean(m.sinPeajeIda);
          g.sinPeajeVuelta ||= Boolean(m.sinPeajeVuelta);
          g.sinCombustible ||= Boolean(m.sinCombustible);
        }
        record.faltantesGrupo = g;
      }
    }
    record.faltantesCounts = {
      ...(mancatosByRecord.get(record.id) ?? { mancatoIda: 0, mancatoVuelta: 0, mancatoSinTramo: 0 }),
      combustibles: record.combustibles ? record.combustibles.length : (record.fuelCount ?? 0),
    };
    record.faltantesDay = record.vehicleId ? (days.get(dayKey(record.vehicleId, romeDay(record.fechaServicio))) ?? null) : null;
  }
  return records;
};

// ---------------------------------------------------------------- registros sin sustentar

// Registros que le faltan sustentar a cada chofer: los peajes de ida y de vuelta y el combustible de sus servicios ya
// hechos que nadie subio ni declaro ("no tuve mancato", "no fue necesario"). Cuenta cada uno de esos faltantes; en un
// viaje compacto los lleva el servicio principal. `olderThanMs` deja afuera lo muy reciente (para el aviso push).
// Devuelve Map(driverId -> { registros, servicios }).
export const countUnsupported = async ({ driverId, olderThanMs = 0 } = {}) => {
  const since = new Date(`${FALTANTES_DESDE}T00:00:00Z`);
  const records = await findRecordsForUnsupported({
    gte: new Date(since.getTime() - DAY_MS),
    lt: new Date(Date.now() + DAY_MS),
    driverId,
  });
  await attachFaltantes(records);

  const byDriver = new Map();
  for (const record of records) {
    const endedAt = new Date(record.horaFinReal ?? record.eta ?? record.fechaServicio).getTime();
    if (Date.now() - endedAt < olderThanMs) continue;
    const { pendientes } = computeFaltantes(record, record.faltantesCounts, record.faltantesDay);
    if (pendientes === 0) continue;
    const entry = byDriver.get(record.driverId) ?? { registros: 0, servicios: 0 };
    entry.registros += pendientes;
    entry.servicios += 1;
    byDriver.set(record.driverId, entry);
  }
  return byDriver;
};

export const countUnsupportedForDriver = async (driverId) =>
  (await countUnsupported({ driverId })).get(driverId) ?? { registros: 0, servicios: 0 };

// ---------------------------------------------------------------- aviso al chofer

const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

// Aviso push a cada chofer con registros sin sustentar de servicios que terminaron hace mas de un dia: cuantos le
// faltan y que, si no los sustenta, puede haber descuentos no esperados en su pago mensual. Un solo mensaje por chofer.
export const remindDriversOfFaltantes = async () => {
  const byDriver = await countUnsupported({ olderThanMs: REMIND_AFTER_MS });
  for (const [driverId, { registros }] of byDriver) {
    await sendPushToUserIds([driverId], {
      title: `Te ${registros === 1 ? "falta 1 registro" : `faltan ${registros} registros`} por sustentar`,
      body: `Tienes ${registros} ${registros === 1 ? "registro" : "registros"} de peajes o carburante sin sustentar. Sube el comprobante o activa el switch si no hubo. Si no los sustentas, pueden aparecer descuentos no esperados en tu pago mensual.`,
      data: { type: "faltantes" },
    }).catch(() => {});
  }
  return { choferes: byDriver.size, registros: [...byDriver.values()].reduce((sum, e) => sum + e.registros, 0) };
};
