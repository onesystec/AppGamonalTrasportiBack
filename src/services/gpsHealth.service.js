import { env } from "../config/env.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { findChoferIdsWithConsentAndService } from "../models/gpsRespaldo.model.js";
import { findOwnerAndAdminUserIds } from "../models/user.model.js";
import { isOnesystecConfigured, probeOnesystec } from "./onesystec.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Estado del GPS de la flota (OneSystec): OK, BLOQUEADO (cuenta rechazada o sin vehiculos, por ejemplo
// por falta de pago), CAIDO (no responde) o NO_CONFIGURADO. No hay un proceso en segundo plano (el
// servidor gratuito se duerme): la comprobacion corre sola cuando alguien consulta el estado, como
// mucho cada 2 minutos. Para no dar falsas alarmas, una cuenta rechazada cuenta enseguida y una caida
// recien despues de 3 comprobaciones seguidas. El estado se guarda en la base para avisar una sola vez
// por cambio, aunque el servidor se reinicie.
const KEY = "gps.estado";
const CHECK_EVERY_MS = 2 * 60 * 1000;
const FORCE_MIN_GAP_MS = 15 * 1000;
const FAIL_AFTER = { BLOQUEADO: 1, CAIDO: 3 };

export const isFailingState = (estado) => estado === "BLOQUEADO" || estado === "CAIDO";

let memo = null;
let inFlight = null;

const EMPTY = { estado: "OK", desde: null, fallos: 0, estadoBruto: "OK", detalle: null, notificado: "OK" };

const notifyChange = async (prev, next) => {
  try {
    const managers = await findOwnerAndAdminUserIds();
    if (isFailingState(next.estado)) {
      await sendPushToUserIds(managers, {
        title: "El GPS de la flota no responde",
        body: `${next.detalle ?? "Sin conexion con OneSystec"}. Se usara el GPS de los celulares autorizados.`,
        data: { type: "gps", estado: next.estado },
      });
      if (env.GPS_RESPALDO_ENABLED) {
        const drivers = await findChoferIdsWithConsentAndService();
        await sendPushToUserIds(drivers, {
          title: "Activa el GPS de respaldo",
          body: "El GPS del vehiculo no responde. Abre la app para que tu celular registre el recorrido de tu servicio.",
          data: { type: "gps-respaldo" },
        });
      }
    } else if (isFailingState(prev.estado)) {
      await sendPushToUserIds(managers, {
        title: "El GPS de la flota volvio",
        body: "OneSystec responde de nuevo. El respaldo del celular se desactiva.",
        data: { type: "gps", estado: "OK" },
      });
    }
  } catch {
    // Best-effort: un fallo de push no debe romper la comprobacion.
  }
};

const runCheck = async () => {
  const saved = { ...EMPTY, ...((await getConfig(KEY))?.valor ?? {}) };
  const now = new Date().toISOString();

  if (!isOnesystecConfigured()) {
    return { estado: "NO_CONFIGURADO", bruto: "NO_CONFIGURADO", detalle: null, desde: null, checkedAt: now, respaldoActivo: false };
  }

  const probe = await probeOnesystec();
  const next = { ...saved };
  if (probe.estado === "OK") {
    next.estado = "OK";
    next.estadoBruto = "OK";
    next.fallos = 0;
    next.detalle = null;
    next.desde = saved.estado === "OK" ? saved.desde : now;
  } else {
    next.estadoBruto = probe.estado;
    next.fallos = (saved.estadoBruto === probe.estado ? saved.fallos : 0) + 1;
    next.detalle = probe.detalle ?? null;
    if (next.fallos >= FAIL_AFTER[probe.estado]) {
      next.estado = probe.estado;
      next.desde = saved.estado === probe.estado ? saved.desde : now;
    }
  }

  // Se avisa una sola vez por cambio de estado.
  if (next.estado !== saved.notificado) {
    await notifyChange(saved, next);
    next.notificado = next.estado;
  }
  if (JSON.stringify(next) !== JSON.stringify(saved)) await setConfig(KEY, next);

  return {
    estado: next.estado,
    bruto: next.estadoBruto,
    detalle: next.detalle,
    desde: next.desde,
    checkedAt: now,
    respaldoActivo: env.GPS_RESPALDO_ENABLED && isFailingState(next.estado),
  };
};

export const getGpsHealth = async ({ force = false } = {}) => {
  const age = memo ? Date.now() - memo.at : Infinity;
  if (memo && (force ? age < FORCE_MIN_GAP_MS : age < CHECK_EVERY_MS)) return memo.health;
  if (!inFlight) {
    inFlight = runCheck()
      .then((health) => {
        memo = { health, at: Date.now() };
        return health;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};
