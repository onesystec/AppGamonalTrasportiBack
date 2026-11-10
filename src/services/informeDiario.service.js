import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { resend } from "../config/resend.js";
import { romeDay } from "../utils/romeTime.js";
import { addDays } from "./informeSemanal.service.js";
import { buildInformeDiarioEmail } from "../emails/informeDiarioEmail.js";

// Informe diario de vencimientos (Oficina Virtual OneSystec): cada manana dice que multas y que mancatos sin pagar vencen
// hoy y manana, y que comunicaciones de datos del conductor (art. 126-bis) tienen el plazo hoy o manana. No usa IA: son
// consultas a la base. Lo usan el correo diario y el endpoint de solo lectura /integraciones/onesystec/resumen-diario.

const asDate = (day) => new Date(`${day}T00:00:00Z`);
const num = (value) => Number(value ?? 0);
const nombre = (u) => (u ? `${u.nombre} ${u.apellido}`.trim() : null);
const DRIVER = { select: { nombre: true, apellido: true } };

const totales = (items, dia) => {
  const delDia = items.filter((i) => i.vence === dia);
  return { cantidad: delDia.length, total: Math.round(delDia.reduce((s, i) => s + i.costo, 0) * 100) / 100 };
};

export const resumenDiario = async (now = new Date()) => {
  const hoy = romeDay(now);
  const manana = addDays(hoy, 1);
  const rango = { gte: asDate(hoy), lte: asDate(manana) };

  const [multasRaw, datosRaw, mancatosRaw, multasVencidas, mancatosVencidos] = await Promise.all([
    prisma.multa.findMany({
      where: { pagado: false, fechaVencimiento: rango },
      include: { driver: DRIVER },
      orderBy: [{ fechaVencimiento: "asc" }, { costo: "desc" }],
    }),
    prisma.multa.findMany({
      where: { datiEstado: "PENDIENTE", datiLimite: rango },
      include: { driver: DRIVER },
      orderBy: { datiLimite: "asc" },
    }),
    prisma.mancatoPagamento.findMany({
      where: { pagado: false, fechaVencimiento: rango },
      include: { driver: DRIVER },
      orderBy: [{ fechaVencimiento: "asc" }, { costo: "desc" }],
    }),
    prisma.multa.count({ where: { pagado: false, fechaVencimiento: { lt: asDate(hoy) } } }),
    prisma.mancatoPagamento.count({ where: { pagado: false, fechaVencimiento: { lt: asDate(hoy) } } }),
  ]);

  const multas = multasRaw.map((m) => ({
    verbale: m.numeroVerbale,
    targa: m.targa,
    chofer: nombre(m.driver),
    titular: m.titular,
    costo: num(m.costo),
    vence: m.fechaVencimiento.toISOString().slice(0, 10),
  }));
  const datosConductor = datosRaw.map((m) => ({
    verbale: m.numeroVerbale,
    targa: m.targa,
    chofer: nombre(m.driver),
    titular: m.titular,
    limite: m.datiLimite.toISOString().slice(0, 10),
  }));
  const mancatos = mancatosRaw.map((m) => ({
    numero: m.numero,
    targa: m.targa,
    chofer: nombre(m.driver),
    sitioWeb: m.sitioWeb,
    observado: m.observado,
    costo: num(m.costo),
    vence: m.fechaVencimiento.toISOString().slice(0, 10),
  }));

  return {
    generadoAt: now.toISOString(),
    hoy,
    manana,
    multas: {
      hoy: totales(multas, hoy),
      manana: totales(multas, manana),
      vencidasSinPagar: multasVencidas,
      items: multas,
    },
    datosConductor: {
      hoy: datosConductor.filter((d) => d.limite === hoy).length,
      manana: datosConductor.filter((d) => d.limite === manana).length,
      items: datosConductor,
    },
    mancatos: {
      hoy: totales(mancatos, hoy),
      manana: totales(mancatos, manana),
      vencidosSinPagar: mancatosVencidos,
      items: mancatos,
    },
  };
};

const destinatariosDiario = () =>
  env.INFORME_DIARIO_DESTINATARIOS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const enviarInformeDiario = async ({ now = new Date(), destinatarios = destinatariosDiario() } = {}) => {
  if (destinatarios.length === 0) throw new Error("No hay destinatarios para el informe diario");
  const resumen = await resumenDiario(now);
  const { subject, html, text } = buildInformeDiarioEmail(resumen);
  const result = await resend.emails.send({ from: env.RESEND_FROM_EMAIL, to: destinatarios, subject, html, text });
  if (result?.error) throw new Error(result.error.message ?? "Resend no acepto el correo");
  return { resumen, destinatarios };
};

// Marca de "ya enviado hoy" en Configuracion, para que un reinicio no repita el correo.
const CLAVE_ULTIMO_DIA = "informeDiario.ultimoDiaEnviado";

// Lo llama el scheduler cada 10 minutos: a partir de INFORME_DIARIO_HORA (hora de Roma) manda el informe una vez por dia.
export const tickInformeDiario = async (now = new Date()) => {
  const hoy = romeDay(now);
  const horaRoma = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).find((p) => p.type === "hour")?.value
  );
  if (horaRoma < env.INFORME_DIARIO_HORA) return;
  const ultimo = (await prisma.configuracion.findUnique({ where: { clave: CLAVE_ULTIMO_DIA } }))?.valor;
  if (ultimo?.dia === hoy) return;
  // Se marca antes de enviar: si Resend falla, mejor un aviso en el log que correos repetidos cada 10 minutos.
  const valor = { dia: hoy, at: now.toISOString() };
  await prisma.configuracion.upsert({ where: { clave: CLAVE_ULTIMO_DIA }, create: { clave: CLAVE_ULTIMO_DIA, valor }, update: { valor } });
  const r = await enviarInformeDiario({ now });
  console.log(
    `[informe-diario] enviado a ${r.destinatarios.length} destinatario(s): ${r.resumen.multas.hoy.cantidad} multa(s) y ${r.resumen.mancatos.hoy.cantidad} mancato(s) vencen hoy`
  );
};
