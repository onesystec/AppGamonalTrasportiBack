import { env } from "../config/env.js";
import { cleanupExpiredRecordFiles } from "./recordFile.service.js";

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
  };

  setInterval(tick, CHECK_EVERY_MS).unref();
};
