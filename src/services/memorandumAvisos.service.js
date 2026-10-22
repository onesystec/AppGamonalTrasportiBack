import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { enPausa, parsePausa } from "../utils/pausaNocturna.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Recordatorios por push de los memorandums: a quien todavia no dio su acuse o su firma, cada MEMO_RECORDATORIO_HORAS horas (cada
// MEMO_RECORDATORIO_URGENTE_HORAS cuando falta un dia o menos para el plazo, o ya paso), de dia (fuera de MEMO_SILENCIO) y hasta
// MEMO_RECORDATORIO_MAX_DIAS dias. Si una persona tiene varios pendientes recibe un solo push. Los pendientes se guardan en memoria: el
// recordatorio los revisa cada pocos minutos sin tocar la base (Neon cobra por hora despierta) y solo consulta cuando hay algo que enviar.
const MIN_MS = 60 * 1000;
const HORA_MS = 60 * MIN_MS;
const DIA_MS = 24 * HORA_MS;

// id del destinatario -> { id, memorandumId, userId, createdAt, plazoAt, ultimoAvisoAt, titulo, numero }
const pendientes = new Map();

export const trackMemorandumRecipients = (rows) => {
  rows.forEach((r) => pendientes.set(r.id, { ...r, ultimoAvisoAt: r.ultimoAvisoAt ?? r.createdAt }));
};

// Ya confirmo (o se elimino el memorandum): no hay que insistir.
export const forgetMemorandum = (destinatarioId) => {
  pendientes.delete(destinatarioId);
};

// Al arrancar: carga los pendientes (una sola consulta).
export const loadPendingMemorandums = async () => {
  const desde = new Date(Date.now() - env.MEMO_RECORDATORIO_MAX_DIAS * DIA_MS);
  const rows = await prisma.memorandumDestinatario.findMany({
    where: { firmadaAt: null, memorandum: { createdAt: { gte: desde } } },
    select: { id: true, memorandumId: true, userId: true, ultimoAvisoAt: true, createdAt: true, memorandum: { select: { plazoAt: true, titulo: true, numero: true } } },
  });
  trackMemorandumRecipients(
    rows.map((r) => ({ id: r.id, memorandumId: r.memorandumId, userId: r.userId, createdAt: r.createdAt, ultimoAvisoAt: r.ultimoAvisoAt, plazoAt: r.memorandum.plazoAt, titulo: r.memorandum.titulo, numero: r.memorandum.numero }))
  );
  return rows.length;
};

export const intervaloRecordatorioHoras = (row, now = new Date()) => {
  const urgente = row.plazoAt && row.plazoAt.getTime() - now.getTime() <= DIA_MS;
  return urgente ? env.MEMO_RECORDATORIO_URGENTE_HORAS : env.MEMO_RECORDATORIO_HORAS;
};

export const debeRecordar = (row, now = new Date()) => now.getTime() - row.ultimoAvisoAt.getTime() >= intervaloRecordatorioHoras(row, now) * HORA_MS;

let corriendo = false;

export const processMemorandumReminders = async (now = new Date()) => {
  if (corriendo || pendientes.size === 0) return 0;
  if (enPausa(parsePausa(env.MEMO_SILENCIO), now)) return 0;

  const limite = now.getTime() - env.MEMO_RECORDATORIO_MAX_DIAS * DIA_MS;
  for (const row of pendientes.values()) {
    if (row.createdAt.getTime() < limite) pendientes.delete(row.id);
  }
  const due = [...pendientes.values()].filter((r) => debeRecordar(r, now));
  if (due.length === 0) return 0;

  corriendo = true;
  try {
    // Solo los que siguen sin confirmar en la base (por si se confirmo desde otra instancia).
    const vigentes = await prisma.memorandumDestinatario.findMany({ where: { id: { in: due.map((r) => r.id) }, firmadaAt: null }, select: { id: true } });
    const vigenteIds = new Set(vigentes.map((v) => v.id));
    due.filter((r) => !vigenteIds.has(r.id)).forEach((r) => pendientes.delete(r.id));
    const aEnviar = due.filter((r) => vigenteIds.has(r.id));

    const porUsuario = new Map();
    aEnviar.forEach((r) => porUsuario.set(r.userId, [...(porUsuario.get(r.userId) ?? []), r]));
    for (const [userId, rows] of porUsuario) {
      const uno = rows.length === 1;
      await sendPushToUserIds([userId], {
        title: uno ? `Memorándum pendiente: ${rows[0].titulo}` : `Tienes ${rows.length} memorándums pendientes`,
        body: uno ? "Ábrelo en la app y confirma que lo recibiste." : "Ábrelos en la app y confirma que los recibiste.",
        data: { type: "memorandum", id: uno ? rows[0].memorandumId : "" },
      }).catch((err) => console.error("No se pudo enviar el recordatorio de memorandum:", err.message));
    }
    if (aEnviar.length > 0) {
      await prisma.memorandumDestinatario.updateMany({ where: { id: { in: aEnviar.map((r) => r.id) } }, data: { ultimoAvisoAt: now, avisos: { increment: 1 } } });
      aEnviar.forEach((r) => {
        pendientes.get(r.id).ultimoAvisoAt = now;
      });
    }
    return aEnviar.length;
  } finally {
    corriendo = false;
  }
};
