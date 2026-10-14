import { env } from "../config/env.js";
import { deleteParadasOlderThan } from "../models/parada.model.js";
import { cleanupExpiredRecordFiles } from "./recordFile.service.js";
import { advancePendingToEnCamino } from "./estadoAutomatico.service.js";
import { remindDriversOfFaltantes } from "./faltantes.service.js";
import { runSeguimientoAlerts } from "./seguimiento.service.js";

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

// Seguimiento en vivo: cada 2 minutos (de 05:00 a 23:00 de Roma) revisa los servicios en camino y avisa por push si alguno no
// tiene GPS o supera su ETA, aunque nadie tenga el mapa abierto. Solo en produccion, como los demas, y se apaga con
// SEGUIMIENTO_MONITOR_ENABLED=false.
export const startSeguimientoMonitor = () => {
  if (env.NODE_ENV !== "production" || !env.SEGUIMIENTO_MONITOR_ENABLED) return;
  const tick = () => {
    const hour = romeHour();
    if (hour < 5 || hour >= 23) return;
    runSeguimientoAlerts().catch(() => {});
  };
  setInterval(tick, 2 * 60 * 1000).unref();
};

// Pendiente -> En camino: pasados AUTO_EN_CAMINO_MIN minutos de la hora de retiro (ver estadoAutomatico.service.js). Corre una vez al
// arrancar (se pone al dia si el servidor estaba dormido) y luego cada minuto. Solo en produccion, como los demas, para que un
// servidor local no cambie estados de la base compartida.
export const startAutoEnCamino = () => {
  if (env.NODE_ENV !== "production" || !(env.AUTO_EN_CAMINO_MIN > 0)) return;
  const tick = async () => {
    try {
      const count = await advancePendingToEnCamino();
      if (count > 0) console.log(`[estado] ${count} servicio(s) pasaron a "En camino" (retiro hace mas de ${env.AUTO_EN_CAMINO_MIN} min)`);
    } catch (err) {
      console.error("[estado] no se pudo pasar servicios a En camino:", err.message);
    }
  };
  void tick();
  setInterval(tick, 60 * 1000).unref();
};
