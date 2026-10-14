import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

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
  return count;
};
