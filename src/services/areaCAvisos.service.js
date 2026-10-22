import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { resend } from "../config/resend.js";
import { buildAreaCEntryEmail, duracion, fechaEnFrase, hora } from "../emails/areaCEntryEmail.js";
import { enPausa, parsePausa } from "../utils/pausaNocturna.js";
import { romeDay, romeLocalToDate } from "../utils/romeTime.js";
import { findOfficeUserIdsForVehicle } from "./notificationScope.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Avisos de Area C sin autorizacion a los Responsables del vehiculo y al Admin:
//  - Al entrar: push + un correo (una sola vez) con el vehiculo, la hora de entrada y el plazo para pagar.
//  - Despues: recordatorios por push cada AREA_C_RECORDATORIO_MIN minutos (cada AREA_C_RECORDATORIO_URGENTE_MIN cuando falta poco para el
//    plazo, y tambien una vez vencido) hasta que la entrada se marque pagada o se descarte. De noche (AREA_C_SILENCIO) no se molesta.
// Las entradas sin pagar se guardan en memoria: el recordatorio revisa esa lista cada pocos minutos sin tocar la base (Neon cobra por
// hora despierta) y solo consulta cuando hay un aviso que enviar.

const MIN_MS = 60 * 1000;
const HORA_MS = 60 * MIN_MS;
const DIA_MS = 24 * HORA_MS;

// entryId -> { id, vehicleId, targa, enteredAt: Date, ultimoAvisoAt: Date }
const pendientes = new Map();

// Fin del plazo para pagar sin recargo: las 23:59 (Roma) del dia de la entrada mas AREA_C_PLAZO_DIAS dias.
export const plazoPagoHasta = (enteredAt) => {
  const [y, m, d] = romeDay(enteredAt).split("-").map(Number);
  const dia = new Date(Date.UTC(y, m - 1, d + env.AREA_C_PLAZO_DIAS)).toISOString().slice(0, 10);
  return romeLocalToDate(dia, "23:59");
};

// Texto del tiempo que queda (o que se paso) respecto al plazo.
const textoRestante = (plazo, now) => {
  const min = (plazo.getTime() - now.getTime()) / MIN_MS;
  return min > 0 ? `Quedan ${duracion(min)} para pagar` : `Plazo vencido hace ${duracion(-min)}: el pago ya tiene recargo`;
};

export const trackAreaCEntry = (entry) => {
  pendientes.set(entry.id, {
    id: entry.id,
    vehicleId: entry.vehicleId,
    targa: entry.targa,
    enteredAt: entry.enteredAt,
    ultimoAvisoAt: entry.ultimoAvisoAt ?? entry.enteredAt,
  });
};

// La entrada se pago, se descarto o se borro: ya no hay que insistir.
export const forgetAreaCEntry = (id) => {
  pendientes.delete(id);
};

// Al arrancar: carga las entradas sin pagar (una sola consulta).
export const loadPendingAreaCEntries = async () => {
  const desde = new Date(Date.now() - env.AREA_C_RECORDATORIO_MAX_DIAS * DIA_MS);
  const rows = await prisma.areaCEntry.findMany({
    where: { pagado: false, descartada: false, enteredAt: { gte: desde } },
    select: { id: true, vehicleId: true, targa: true, enteredAt: true, ultimoAvisoAt: true },
  });
  rows.forEach(trackAreaCEntry);
  return rows.length;
};

// Cada cuantos minutos toca insistir segun lo que falta para el plazo.
export const intervaloRecordatorioMin = (entry, now = new Date()) => {
  const restanteH = (plazoPagoHasta(entry.enteredAt).getTime() - now.getTime()) / HORA_MS;
  return restanteH > 0 && restanteH <= env.AREA_C_URGENTE_HORAS ? env.AREA_C_RECORDATORIO_URGENTE_MIN : env.AREA_C_RECORDATORIO_MIN;
};

export const debeRecordar = (entry, now = new Date()) =>
  now.getTime() - entry.ultimoAvisoAt.getTime() >= intervaloRecordatorioMin(entry, now) * MIN_MS;

const enviarCorreos = async (userIds, datos) => {
  const usuarios = await prisma.user.findMany({
    where: { id: { in: userIds }, estado: "ACTIVO" },
    select: { nombre: true, correoElectronico: true },
  });
  const resultados = await Promise.allSettled(
    usuarios.map((u) => {
      const { subject, html, text } = buildAreaCEntryEmail({ nombre: u.nombre, ...datos });
      return resend.emails.send({ from: env.RESEND_FROM_EMAIL, to: u.correoElectronico, subject, html, text });
    })
  );
  resultados.forEach((r) => {
    if (r.status === "rejected") console.error("[area-c] no se pudo enviar el correo:", r.reason?.message ?? r.reason);
  });
  return { enviados: resultados.filter((r) => r.status === "fulfilled").length, total: usuarios.length };
};

// Entrada nueva (la crea checkAreaCEntries en vehicle.service.js): push + correo a Responsables y Admin y empieza el seguimiento.
export const avisarEntradaAreaC = async (entry) => {
  const plazo = plazoPagoHasta(entry.enteredAt);
  const ahora = new Date();
  const vehiculo = await prisma.vehiculo.findUnique({ where: { id: entry.vehicleId }, select: { modelo: true } });
  const destinatarios = await findOfficeUserIdsForVehicle(entry.vehicleId);

  await sendPushToUserIds(destinatarios, {
    title: `Área C sin autorización: ${entry.targa}`,
    body: `Entró a las ${hora(entry.enteredAt)}. Pagar antes del ${fechaEnFrase(plazo)}, ${hora(plazo)}. ${textoRestante(plazo, ahora)}.`,
    data: { type: "area-c", targa: entry.targa, entryId: entry.id },
  }).catch((err) => console.error("No se pudo enviar push de Area C:", err.message));

  const correos = await enviarCorreos(destinatarios, {
    targa: entry.targa,
    modelo: vehiculo?.modelo,
    enteredAt: entry.enteredAt,
    plazoHasta: plazo,
  }).catch((err) => {
    console.error("[area-c] fallo el envio de correos:", err.message);
    return { enviados: 0, total: 0 };
  });

  const updated = await prisma.areaCEntry.update({
    where: { id: entry.id },
    data: { ultimoAvisoAt: ahora, avisos: { increment: 1 }, ...(correos.enviados > 0 ? { avisoEmailAt: ahora } : {}) },
  });
  trackAreaCEntry(updated);
  return { destinatarios: destinatarios.length, correosEnviados: correos.enviados, correosTotal: correos.total };
};

let corriendo = false;

// Recordatorios: para cada entrada pendiente que ya toca, confirma en la base que sigue sin pagar y manda el push.
export const processAreaCReminders = async (now = new Date()) => {
  if (corriendo || pendientes.size === 0) return 0;
  if (enPausa(parsePausa(env.AREA_C_SILENCIO), now)) return 0;

  const limite = now.getTime() - env.AREA_C_RECORDATORIO_MAX_DIAS * DIA_MS;
  for (const entry of pendientes.values()) {
    if (entry.enteredAt.getTime() < limite) pendientes.delete(entry.id);
  }
  const due = [...pendientes.values()].filter((e) => debeRecordar(e, now));
  if (due.length === 0) return 0;

  corriendo = true;
  try {
    const vigentes = await prisma.areaCEntry.findMany({
      where: { id: { in: due.map((e) => e.id) }, pagado: false, descartada: false },
      select: { id: true, vehicleId: true, targa: true, enteredAt: true },
    });
    const vigenteIds = new Set(vigentes.map((e) => e.id));
    due.filter((e) => !vigenteIds.has(e.id)).forEach((e) => pendientes.delete(e.id));

    for (const entry of vigentes) {
      const plazo = plazoPagoHasta(entry.enteredAt);
      const destinatarios = await findOfficeUserIdsForVehicle(entry.vehicleId);
      await sendPushToUserIds(destinatarios, {
        title: `Área C sin pagar: ${entry.targa}`,
        body: `${textoRestante(plazo, now)} (hasta el ${fechaEnFrase(plazo)}, ${hora(plazo)}). Entró a las ${hora(entry.enteredAt)}. Márcala como pagada en la app.`,
        data: { type: "area-c", targa: entry.targa, entryId: entry.id },
      }).catch((err) => console.error("No se pudo enviar el recordatorio de Area C:", err.message));
      await prisma.areaCEntry.update({ where: { id: entry.id }, data: { ultimoAvisoAt: now, avisos: { increment: 1 } } });
      pendientes.get(entry.id).ultimoAvisoAt = now;
    }
    return vigentes.length;
  } finally {
    corriendo = false;
  }
};
