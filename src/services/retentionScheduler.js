import { env } from "../config/env.js";
import { deleteParadasOlderThan } from "../models/parada.model.js";
import { cleanupExpiredRecordFiles } from "./recordFile.service.js";
import { remindDriversOfFaltantes } from "./faltantes.service.js";

// Limpieza diaria de fotos de comprobante vencidas (ver RECORD_FILE_RETENTION_DAYS).
// Antes los jobs de limpieza dependian de un scheduler externo porque Render free se
// apagaba solo; en un plan pago el proceso queda siempre arriba, asi que alcanza con un
// timer en memoria. Revisa cada hora y corre una sola vez al dia, a las 12:00 de Roma
// (horario en que la base suele estar despierta de todas formas, para no despertar Neon
// solo por esto). Si el proceso se reinicia, simplemente corre en la proxima ventana:
// el borrado es idempotente.
const CHECK_EVERY_MS = 60 * 60 * 1000;
const RUN_HOUR_ROME = 12;
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

const romeHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .find((p) => p.type === "hour")?.value
  );

export const startRetentionScheduler = () => {
  // En desarrollo se comparte la misma base y el mismo bucket R2 que produccion: no
  // corre solo, para que un servidor local no borre nada por su cuenta.
  if (env.NODE_ENV !== "production") return;

  let lastRunAt = 0;

  const tick = async () => {
    if (romeHour() !== RUN_HOUR_ROME) return;
    if (Date.now() - lastRunAt < MIN_GAP_MS) return;
    lastRunAt = Date.now();

    try {
      const result = await cleanupExpiredRecordFiles();
      if (result.deletedCount > 0 || result.failedCount > 0) {
        console.log(
          `[retencion] fotos de comprobante vencidas: ${result.deletedCount} borradas, ${result.failedCount} con error`
        );
      }
    } catch (err) {
      console.error("[retencion] fallo la limpieza de fotos vencidas:", err.message);
    }

    try {
      const cutoff = new Date(Date.now() - env.PARADA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const { count } = await deleteParadasOlderThan(cutoff);
      if (count > 0) console.log(`[retencion] paradas de vehiculo viejas borradas: ${count}`);
    } catch (err) {
      console.error("[retencion] fallo la limpieza de paradas:", err.message);
    }
  };

  setInterval(tick, CHECK_EVERY_MS).unref();
};

// Aviso diario a los choferes con registros sin sustentar (peajes o carburante de servicios que terminaron hace mas de
// un dia): cuantos les faltan y que pueden haber descuentos en el pago mensual. Una vez al dia, a las 12:00 de Roma. Como
// la limpieza, no corre en desarrollo para no mandar avisos reales desde un servidor local.
export const startFaltantesReminder = () => {
  if (env.NODE_ENV !== "production") return;

  let lastRunAt = 0;

  const tick = async () => {
    if (romeHour() !== RUN_HOUR_ROME) return;
    if (Date.now() - lastRunAt < MIN_GAP_MS) return;
    lastRunAt = Date.now();
    try {
      const result = await remindDriversOfFaltantes();
      if (result.choferes > 0) {
        console.log(`[faltantes] avisos enviados: ${result.choferes} choferes, ${result.registros} registros sin sustentar`);
      }
    } catch (err) {
      console.error("[faltantes] fallo el recordatorio:", err.message);
    }
  };

  setInterval(tick, CHECK_EVERY_MS).unref();
};
