import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { SIN_ASIGNAR_CORREO, SIN_ASIGNAR_TARGA } from "../constants/sinAsignar.js";
import { AppError } from "../utils/AppError.js";
import { hostPrivato } from "../utils/codiceCollegamento.js";
import { decryptSecret } from "../utils/secretBox.js";

// Llamadas SALIENTES de Gamonal a la otra app One Driver (App Piazza) y utilidades comunes (ver model Collegamento).
// Sincroniza el estado y los adjuntos de servicios vinculados. Las notificaciones automáticas no bloquean la operación original.

export const sha256 = (testo) => createHash("sha256").update(String(testo)).digest("hex");
export const nuovoToken = () => randomBytes(32).toString("base64url");

// Comparacion en tiempo constante del token recibido contra el hash guardado.
export const stessoHash = (token, hash) => {
  if (typeof token !== "string" || !token || !hash) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const nomeAzienda = () => env.EMPRESA_RAZON_SOCIAL || env.EMPRESA_NOMBRE;

const TIMEOUT_MS = 10_000;

// En produccion la direccion debe resolver SOLO a IP publicas (un nombre que apunte a 127.0.0.1 o a una red interna se rechaza: DNS rebinding / SSRF).
export const controllaDestinazione = async (baseUrl) => {
  if (env.NODE_ENV !== "production") return;
  let indirizzi;
  try {
    indirizzi = await lookup(new URL(baseUrl).hostname, { all: true });
  } catch {
    throw new AppError("L'altra app non risponde (irraggiungibile)", 502);
  }
  if (!indirizzi.length || indirizzi.some((i) => hostPrivato(i.address))) throw new AppError("Indirizzo dell'altra app non ammesso", 400);
};

// Llamada POST al API publico de collegamenti de la otra app. Lanza AppError 502; err.riprova = true si vale la pena reintentar (no responde / error 5xx / 429).
export const chiamaRemoto = async (baseUrl, percorso, { token, body, contentType } = {}) => {
  await controllaDestinazione(baseUrl);
  const foto = Buffer.isBuffer(body);
  let res;
  try {
    res = await fetch(`${baseUrl}/api/collegamenti/pubblico${percorso}`, {
      method: "POST",
      headers: { "Content-Type": foto ? (contentType ?? "image/webp") : "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: foto ? body : JSON.stringify(body ?? {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = new AppError(`L'altra app non risponde (${err.name === "TimeoutError" ? "tempo scaduto" : "irraggiungibile"})`, 502);
    e.riprova = true;
    throw e;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new AppError(json?.message ? `L'altra app: ${json.message}` : `L'altra app ha risposto ${res.status}`, 502);
    e.riprova = res.status >= 500 || res.status === 429;
    throw e;
  }
  return json?.data ?? {};
};

export const chiamaCollegamento = (collegamento, percorso, body, { contentType } = {}) => {
  if (!collegamento.tokenUscente || !collegamento.remotoId) throw new AppError("Collegamento non ancora attivo", 409);
  return chiamaRemoto(collegamento.remotoUrl, `/${collegamento.remotoId}${percorso}`, { token: decryptSecret(collegamento.tokenUscente), body, contentType });
};

// Render duerme las apps gratuitas: se reintenta con espera creciente (2 s, 8 s, 30 s) solo si el fallo es transitorio.
export const ESPERAS_MS = [2000, 8000, 30000];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
export const chiamaConRiprova = async (collegamento, percorso, body, { esperas = ESPERAS_MS, chiama = chiamaCollegamento, contentType } = {}) => {
  for (let intento = 0; ; intento += 1) {
    try {
      return await chiama(collegamento, percorso, body, { contentType });
    } catch (err) {
      if (!err.riprova || intento >= esperas.length) throw err;
      await dormir(esperas[intento]);
    }
  }
};

const esigeApplicato = (esito) => {
  if (esito.ignorato === true) {
    const motivo = typeof esito.motivo === "string" && esito.motivo.trim()
      ? esito.motivo.trim()
      : "Servizio remoto assente o non assegnato a questo fornitore";
    throw new AppError(`L'altra app ha ignorato l'aggiornamento: ${motivo}`, 502);
  }
};

const inviaAggiornamento = async (collegamento, body, options) =>
  esigeApplicato(await chiamaConRiprova(collegamento, "/aggiornamenti", body, options));

// Recuerda el ultimo problema (se ve en la lista de conexiones) o lo borra cuando vuelve a funcionar.
export const segnaEsito = (collegamentoId, err) =>
  prisma.collegamento
    .update({ where: { id: collegamentoId }, data: err ? { ultimoErrore: String(err.message ?? err).slice(0, 300), ultimoErroreAt: new Date() } : { ultimoErrore: null, ultimoErroreAt: null } })
    .catch(() => {});

const seguro = (nome, promesa) => promesa.catch((err) => console.error(`[collegamenti] ${nome}:`, err.message));

// ---- Estado que se avisa a la otra app ----

const nomePersona = (p) => (p && p.correoElectronico !== SIN_ASIGNAR_CORREO ? `${p.nombre} ${p.apellido}`.trim() : null);

// Las fichas internas "Sin asignar" cuentan como vacío.
export const datiAggiornamento = (record) => ({
  estado: record.estado,
  autista: nomePersona(record.driver),
  targa: !["PENDIENTE", "VEHICULO_PENDIENTE"].includes(record.aceptacionChofer) && record.vehicle?.targa && record.vehicle.targa !== SIN_ASIGNAR_TARGA ? record.vehicle.targa : null,
});

// Campo por campo (Postgres guarda el JSON con otro orden de claves, asi que no sirve comparar el texto).
export const stessiDati = (a, b) => Boolean(a && b) && a.estado === b.estado && (a.autista ?? null) === (b.autista ?? null) && (a.targa ?? null) === (b.targa ?? null);

const INCLUDE_SYNC = {
  collegamento: true,
  empresa: { include: { collegamento: true } },
  record: { select: { id: true, estado: true, aceptacionChofer: true, driver: { select: { nombre: true, apellido: true, correoElectronico: true } }, vehicle: { select: { targa: true } } } },
};

// Una solicitud desconectada solo puede usar una conexión aprobada con la misma ficha.
const collegamentoAttivo = (solicitud) => {
  const collegamento = solicitud.collegamento ?? solicitud.empresa?.collegamento;
  if (collegamento?.stato !== "ATTIVO" || collegamento.ruolo !== "CLIENTE") {
    throw new AppError("Non c'è un collegamento attivo per il cliente di questa richiesta", 409);
  }
  return collegamento;
};

export const inviaAllegato = async ({ id, recordId, tipoArchivo }, buffer, contentType) => {
  const solicitud = await prisma.solicitudServicio.findFirst({
    where: { recordId, recordRemotoId: { not: null }, estado: "ACEPTADA" },
    include: { collegamento: true, empresa: { include: { collegamento: true } } },
  });
  if (!solicitud) return false;
  const collegamento = collegamentoAttivo(solicitud);
  const percorso = `/servizi/${encodeURIComponent(solicitud.recordRemotoId)}/bolle/${encodeURIComponent(id)}?tipoArchivo=${encodeURIComponent(tipoArchivo)}`;
  try {
    const esito = await chiamaConRiprova(collegamento, percorso, buffer, { contentType });
    esigeApplicato(esito);
    if (esito.ok !== true) throw new AppError("L'altra app non ha confermato la ricezione dell’allegato", 502);
    return true;
  } catch (err) {
    await segnaEsito(collegamento.id, err);
    throw err;
  }
};

export const notificaAllegato = (file, buffer, contentType) => seguro("allegato", inviaAllegato(file, buffer, contentType));

// Avisa a la otra app el estado, chofer y targa actuales de un servicio que vino por una conexion. Solo manda si algo cambio desde el ultimo aviso
// (se puede llamar las veces que haga falta). forzar = true manda de nuevo igual ("Reinvia"). Lanza el error (para el boton); los disparos
// automaticos usan sincronizzaSicuro.
export const sincronizza = async ({ solicitudId, recordId }, { forzar = false, esperas } = {}) => {
  if (!solicitudId && !recordId) return { inviato: false };
  const solicitud = await prisma.solicitudServicio.findFirst({
    where: {
      ...(solicitudId ? { id: solicitudId, recordId: { not: null } } : { recordId }),
      recordRemotoId: { not: null },
      estado: "ACEPTADA",
    },
    include: INCLUDE_SYNC,
  });
  if (!solicitud?.record) {
    if (forzar) throw new AppError("La richiesta non ha un servizio collegato da reinviare", 409);
    return { inviato: false };
  }

  const collegamento = collegamentoAttivo(solicitud);
  const dati = datiAggiornamento(solicitud.record);
  if (!forzar && solicitud.collegamentoId && stessiDati(dati, solicitud.ultimoEnviado)) return { inviato: false };
  try {
    await inviaAggiornamento(collegamento, { recordId: solicitud.recordRemotoId, tipo: "AGGIORNAMENTO", ...dati }, esperas ? { esperas } : undefined);
    await prisma.solicitudServicio.updateMany({
      where: { id: solicitud.id, collegamentoId: solicitud.collegamentoId },
      data: { ultimoEnviado: dati, collegamentoId: collegamento.id },
    });
    await segnaEsito(collegamento.id, null);
    return { inviato: true };
  } catch (err) {
    await segnaEsito(collegamento.id, err);
    throw err;
  }
};

export const sincronizzaSicuro = (ref) => seguro("aggiornamento", sincronizza(ref));

// Despues de un cambio masivo (estado automatico, viaje compactado...): revisa los servicios abiertos que vinieron por una conexion.
export const sincronizzaAperti = () =>
  seguro(
    "aggiornamenti",
    (async () => {
      const aperti = await prisma.solicitudServicio.findMany({
        where: { recordRemotoId: { not: null }, estado: "ACEPTADA", recordId: { not: null }, record: { estado: { notIn: ["ANNULLATO"] } } },
        select: { id: true },
        take: 200,
      });
      for (const s of aperti) await sincronizza({ solicitudId: s.id }).catch((err) => console.error("[collegamenti] aggiornamento:", err.message));
    })()
  );

// ACCETTATO / RIFIUTATO de una solicitud que vino por una conexion. Nunca rompe la operacion que lo origina.
export const notificaEsitoSolicitud = (solicitud, tipo, motivo) =>
  seguro(
    `esito ${tipo}`,
    (async () => {
      if (!solicitud?.collegamentoId || !solicitud.recordRemotoId) return;
      const collegamento = await prisma.collegamento.findUnique({ where: { id: solicitud.collegamentoId } });
      if (!collegamento || collegamento.stato !== "ATTIVO") return;
      try {
        await inviaAggiornamento(collegamento, { recordId: solicitud.recordRemotoId, tipo, ...(motivo ? { motivo: String(motivo).slice(0, 500) } : {}) });
        await segnaEsito(collegamento.id, null);
      } catch (err) {
        await segnaEsito(collegamento.id, err);
        throw err;
      }
      // Aceptado: tambien se avisa ya quien es el chofer y la targa (si la oficina ya los eligio).
      if (tipo === "ACCETTATO") await sincronizza({ solicitudId: solicitud.id }, { forzar: true }).catch((err) => console.error("[collegamenti] aggiornamento:", err.message));
    })()
  );
