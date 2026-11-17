import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { sincronizzaAperti } from "./collegamentoInvio.service.js";

// Un servicio "Pendiente" (IN_SOSPESO) pasa solo a "En camino" (IN_CONSEGNA) cuando su hora de retiro (fechaRetiro, la salida del
// vehiculo) ya paso hace AUTO_EN_CAMINO_MIN minutos. Solo mira los ultimos dias: no toca servicios viejos que nunca se cerraron, y si
// el servidor estuvo dormido se pone al dia en la primera vuelta. Los que ya estan retirados, en camino, entregados, anulados o
// reprogramados no se tocan, y un servicio sin hora de retiro tampoco (no hay a partir de cuando contar).
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const advancePendingToEnCamino = async (now = Date.now()) => {
  const minutes = env.AUTO_EN_CAMINO_MIN;
  if (!(minutes > 0)) return 0;

  // Primero se busca (una lectura) y solo se escribe si hay algo: cada escritura sobre servicios vacia la cache de las pantallas.
  const due = await prisma.record.findMany({
    where: {
      estado: "IN_SOSPESO",
      fechaRetiro: { lte: new Date(now - minutes * 60 * 1000), gte: new Date(now - LOOKBACK_MS) },
    },
    select: { id: true },
  });
  if (due.length === 0) return 0;

  // El estado se vuelve a exigir al escribir: si alguien lo cambio entre las dos consultas, gana lo que hizo.
  const { count } = await prisma.record.updateMany({
    where: { id: { in: due.map((r) => r.id) }, estado: "IN_SOSPESO" },
    data: { estado: "IN_CONSEGNA" },
  });
  // App conectada (App Piazza): los servicios que pasaron a "En camino" se le avisan.
  if (count > 0) void sincronizzaAperti();
  return count;
};

// ---- Cuando hace falta volver a mirar la base ----
// Mirar cada minuto si hay servicios por pasar a "En camino" mantenia despierta a Neon (que se cobra por hora despierta) todo el dia aunque no hubiera
// nada que hacer. Ahora, tras cada revision se calcula cuando vencera el siguiente servicio (su hora de retiro + AUTO_EN_CAMINO_MIN) y no se consulta
// hasta entonces, salvo que se escriba algo en los servicios (se crea o cambia uno: el numero de escrituras de utils/responseCache.js cambia) o pasen
// MAX_SIN_REVISAR_MS (red de seguridad).
export const MAX_SIN_REVISAR_MS = 30 * 60 * 1000;

// Cuando vence el siguiente servicio pendiente que todavia no cumple el plazo (ms), o null si no hay ninguno.
export const proximoAutoEnCamino = async (now = Date.now()) => {
  const minutes = env.AUTO_EN_CAMINO_MIN;
  if (!(minutes > 0)) return null;
  const next = await prisma.record.findFirst({
    where: { estado: "IN_SOSPESO", fechaRetiro: { gt: new Date(now - minutes * 60 * 1000) } },
    orderBy: { fechaRetiro: "asc" },
    select: { fechaRetiro: true },
  });
  return next?.fechaRetiro ? next.fechaRetiro.getTime() + minutes * 60 * 1000 : null;
};

// Que se recuerda de la ultima revision: hasta cuando no hace falta mirar y con que numero de escrituras se calculo.
export const calcularProximaRevision = ({ vence, version, ahora = Date.now() }) => ({ version, hasta: Math.min(vence ?? Infinity, ahora + MAX_SIN_REVISAR_MS) });

// true si hay que consultar la base: nunca se reviso, se escribio algo en los servicios, o ya llego la hora.
export const hayQueConsultar = ({ proxima, version, ahora = Date.now() }) => !proxima || proxima.version !== version || ahora >= proxima.hasta;
