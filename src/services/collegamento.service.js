import { randomInt } from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { CodiceNonValido, codiceScaduto, formatoCodice, leggiCodice as leggiCodiceBase, urlValida } from "../utils/codiceCollegamento.js";
import { encryptSecret } from "../utils/secretBox.js";
import { createClient } from "./client.service.js";
import { Prisma } from "@prisma/client";
import { SOLICITUD_SERVICIOS } from "../constants/solicitudes.js";
import { SIN_ASIGNAR_CORREO, SIN_ASIGNAR_TARGA } from "../constants/sinAsignar.js";
import { avisarServicioDirecto, crearServicioDirecto, resolverClientePorNombre } from "./servicioDirecto.service.js";
import { detectarTipoServicio, textoDeServicio, tipoDeSolicitud } from "./collegamentoTipo.service.js";
import { confronta, normalizzaDati, registraCambi, registraHito } from "./collegamentoCambi.service.js";
import {
  chiamaCollegamento,
  controllaDestinazione,
  nomeAzienda,
  notificaEsitoSolicitud,
  nuovoToken,
  sha256,
  sincronizza,
  stessoHash,
} from "./collegamentoInvio.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { ownerAndResponsableIds } from "./solicitud.service.js";

// App collegate: conexion segura entre apps One Driver. App Piazza (A) asigna servicios a Gamonal (B) y Gamonal le responde.
//  1. El Owner de Gamonal comparte su "codice di collegamento" (XXXX-XXXX@host). En la ficha del fornitore de Piazza se pega ese codigo.
//  2. Piazza llama a /richiesta con el segreto y un token (T1) que Gamonal usara para llamarla: queda DA_APPROVARE (T1 cifrado).
//  3. El Owner acepta: se elige o crea la ficha del cliente, se genera T2 y se manda a Piazza (/esito). Solo si Piazza responde OK queda ATTIVO.
//  4. Es un BUZON: Piazza solo puede dejar servicios en "Solicitudes" (/servizi), anularlos o desconectarse. No puede leer, editar ni borrar nada mas.
// Gamonal siempre es el lado CLIENTE de la fila (recibe).

const CHIAVE_CODICE = "collegamento.codice";
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const nuovoSegreto = () => {
  const c = Array.from({ length: 8 }, () => ALFABETO[randomInt(ALFABETO.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

// Direccion publica de esta API (sin "/" final). En produccion conviene PUBLIC_API_URL; si no, se saca de la peticion (Render manda x-forwarded-proto).
export const urlPropria = (req) => (env.PUBLIC_API_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

export const opzioniIndirizzo = () => ({ produzione: env.NODE_ENV === "production", hostPermessi: env.COLLEGAMENTI_HOST_PERMESSI });

// El codigo vale COLLEGAMENTI_CODICE_ORE horas y se usa una sola vez: tras una solicitud valida (o caducado) se genera otro.
const salvaSegreto = async () => {
  const segreto = nuovoSegreto();
  const valor = { segreto, creadoAt: new Date().toISOString() };
  await prisma.configuracion.upsert({ where: { clave: CHIAVE_CODICE }, create: { clave: CHIAVE_CODICE, valor }, update: { valor } });
  return valor;
};

const leggiSegreto = async () => {
  const valor = (await prisma.configuracion.findUnique({ where: { clave: CHIAVE_CODICE } }))?.valor;
  if (!valor?.segreto || codiceScaduto(valor.creadoAt, { ore: env.COLLEGAMENTI_CODICE_ORE })) return null;
  return valor;
};

const assicuraSegreto = async () => (await leggiSegreto()) ?? (await salvaSegreto());

// Comparacion en tiempo constante (se comparan los hashes, no el texto).
export const stessoSegreto = (a, b) => stessoHash(String(a ?? ""), sha256(String(b ?? "")));

const dto = (c) => ({
  id: c.id,
  ruolo: c.ruolo,
  stato: c.stato,
  remotoNome: c.remotoNome,
  remotoPartitaIva: c.remotoPartitaIva ?? null,
  remotoUrl: c.remotoUrl,
  client: c.client ? { id: c.client.id, nombre: c.client.nombre } : null,
  condividiServiziInCorso: c.condividiServiziInCorso,
  ultimoErrore: c.ultimoErrore ?? null,
  ultimoErroreAt: c.ultimoErroreAt ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const INCLUDE = { client: { select: { id: true, nombre: true } } };

// ---- Oficina (Owner) ----

export const statoCollegamenti = async (req) => {
  const segreto = await assicuraSegreto();
  const righe = await prisma.collegamento.findMany({ include: INCLUDE, orderBy: { createdAt: "desc" } });
  return {
    codice: formatoCodice(segreto.segreto, urlPropria(req)),
    scadeAt: new Date(new Date(segreto.creadoAt).getTime() + env.COLLEGAMENTI_CODICE_ORE * 3600_000).toISOString(),
    nome: nomeAzienda(),
    cifratura: Boolean(env.COLLEGAMENTI_ENCRYPTION_KEY),
    collegamenti: righe.map(dto),
  };
};

export const rigeneraCodice = async (req) => {
  const { segreto, creadoAt } = await salvaSegreto();
  return { codice: formatoCodice(segreto, urlPropria(req)), scadeAt: new Date(new Date(creadoAt).getTime() + env.COLLEGAMENTI_CODICE_ORE * 3600_000).toISOString() };
};

const trovaRiga = async (id) => {
  const riga = await prisma.collegamento.findUnique({ where: { id }, include: INCLUDE });
  if (!riga) throw new AppError("Collegamento non trovato", 404);
  return riga;
};

// Acepta la solicitud de conexion. clientId = ficha de cliente ya existente; sin eso, se crea una con el nombre de la otra empresa.
export const accettaCollegamento = async (actor, id, { clientId } = {}) => {
  const riga = await trovaRiga(id);
  if (riga.stato !== "DA_APPROVARE") throw new AppError("Questa richiesta non è più da approvare", 409);
  let cliente;
  if (clientId) {
    cliente = await prisma.client.findUnique({ where: { id: clientId }, include: { collegamento: true } });
    if (!cliente) throw new AppError("Cliente non trovato", 404);
    if (cliente.collegamento && cliente.collegamento.id !== id) throw new AppError("Questo cliente ha già un'app collegata", 409);
  }
  const token = nuovoToken();
  // Primero se avisa a la otra app: solo si responde OK queda ATTIVO (y recien ahi se crea la ficha, si hacia falta).
  await chiamaCollegamento(riga, "/esito", { esito: "ACCETTATO", token, nome: nomeAzienda() });
  if (!cliente) cliente = await createClient({ nombre: riga.remotoNome });
  const aggiornata = await prisma.collegamento.update({
    where: { id },
    data: { stato: "ATTIVO", tokenEntranteHash: sha256(token), clientId: cliente.id, creadoDaId: actor.id, ultimoErrore: null, ultimoErroreAt: null },
    include: INCLUDE,
  });
  return dto(aggiornata);
};

// Interruptor del Owner: compartir (o no) con esta app los servicios en curso con su posicion.
export const impostaCondivisione = async (_actor, id, condividiServiziInCorso) => {
  const riga = await trovaRiga(id);
  if (riga.stato !== "ATTIVO") throw new AppError("Il collegamento non è attivo", 409);
  return dto(await prisma.collegamento.update({ where: { id }, data: { condividiServiziInCorso }, include: INCLUDE }));
};

export const rifiutaCollegamento = async (_actor, id) => {
  const riga = await trovaRiga(id);
  if (riga.stato !== "DA_APPROVARE") throw new AppError("Questa richiesta non è più da approvare", 409);
  await chiamaCollegamento(riga, "/esito", { esito: "RIFIUTATO" }).catch(() => {});
  await prisma.collegamento.delete({ where: { id } });
};

// Desconectar: se avisa a la otra app (si responde) y se borra la fila. El historial de servicios queda.
export const scollega = async (_actor, id) => {
  const riga = await trovaRiga(id);
  if (riga.remotoId && riga.tokenUscente) await chiamaCollegamento(riga, "/scollega", {}).catch(() => {});
  await prisma.collegamento.delete({ where: { id } });
};

// "Reinvia" de una solicitud ya aceptada: vuelve a avisar estado, chofer y targa a la otra app.
export const reinviaSolicitud = async (solicitudId) => {
  const solicitud = await prisma.solicitudServicio.findUnique({ where: { id: solicitudId }, select: { id: true, collegamentoId: true, estado: true } });
  if (!solicitud?.collegamentoId) throw new AppError("Questa richiesta non arriva da un'app collegata", 409);
  if (solicitud.estado !== "ACEPTADA") throw new AppError("La richiesta non è ancora stata accettata", 409);
  return sincronizza({ solicitudId }, { forzar: true });
};

// ---- API publica (la llama la otra app) ----

// Mismo 403 generico para codigo invalido, caducado o ya usado (no se revela cual).
export const riceviRichiesta = async (body) => {
  const segreto = (await leggiSegreto())?.segreto;
  if (!segreto || !stessoSegreto(String(body.segreto).toUpperCase(), segreto)) throw new AppError("Codice di collegamento non valido, scaduto o già usato", 403);
  let url;
  try {
    url = urlValida(body.url, opzioniIndirizzo());
  } catch (err) {
    if (err instanceof CodiceNonValido) throw new AppError("Indirizzo dell'app non valido", 400);
    throw err;
  }
  await controllaDestinazione(url);
  const risposta = (id) => ({ id, nome: nomeAzienda(), partitaIva: env.EMPRESA_PARTITA_IVA || null });
  // Idempotente por (url, id de la otra app): un reintento devuelve la misma fila.
  const esistente = await prisma.collegamento.findFirst({ where: { remotoUrl: url, remotoId: body.idRemoto } });
  if (esistente) return risposta(esistente.id);
  const riga = await prisma.collegamento.create({
    data: {
      ruolo: "CLIENTE",
      stato: "DA_APPROVARE",
      remotoUrl: url,
      remotoId: body.idRemoto,
      remotoNome: body.nome,
      remotoPartitaIva: body.partitaIva ?? null,
      tokenUscente: encryptSecret(body.token),
    },
  });
  // Codigo de un solo uso: con la solicitud registrada se genera otro enseguida.
  await salvaSegreto();
  const owners = await prisma.user.findMany({ where: { cargo: "OWNER", estado: "ACTIVO" }, select: { id: true } });
  void sendPushToUserIds(
    owners.map((u) => u.id),
    { title: "Solicitud de conexion", body: `${body.nome} quiere conectar su app One Driver con la tuya. Aceptala en App collegate.`, data: { type: "collegamento" } }
  ).catch(() => {});
  return risposta(riga.id);
};

// Middleware: la otra app se presenta con el token que le dimos (T2). 401 IDENTICO si el id no existe o el token no coincide (no se revela nada).
export const autenticaRemoto = async (req, _res, next) => {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const riga = await prisma.collegamento.findUnique({ where: { id: req.params.id }, include: { client: true } });
    if (!riga || !stessoHash(token, riga.tokenEntranteHash)) throw new AppError("Collegamento non autorizzato", 401);
    req.collegamento = riga;
    next();
  } catch (err) {
    next(err);
  }
};

const richiedeAttivo = (riga) => {
  if (riga.stato !== "ATTIVO") throw new AppError("Il collegamento non è attivo", 409);
  if (riga.ruolo !== "CLIENTE") throw new AppError("Operazione non prevista per questo collegamento", 409);
};

export const riceviScollega = async (riga) => {
  await prisma.collegamento.delete({ where: { id: riga.id } });
  return { ok: true };
};

const utenteDelCollegamento = async (riga) => {
  const id = riga.creadoDaId ?? (await prisma.user.findFirst({ where: { cargo: "OWNER", estado: "ACTIVO" }, select: { id: true } }))?.id;
  if (!id) throw new AppError("Nessun utente per registrare la consegna", 500);
  return id;
};

// Datos de la solicitud a partir de lo que manda la otra app. Lo que Gamonal no tiene como campo (mercancia, remitente, paradas) va en la descripcion.
export const datiSolicitud = (s, riga) => {
  const tappe = (s.tappe ?? []).filter(Boolean);
  const merce = [s.pesoKg != null ? `${s.pesoKg} kg` : null, s.dimensioni || null, s.colli != null ? `${s.colli} colli` : null].filter(Boolean).join(" · ");
  const descripcion = [
    s.codigo || s.shipment ? `Codice ${riga.remotoNome}: ${[s.codigo, s.shipment && s.shipment !== s.codigo ? s.shipment : null].filter(Boolean).join(" / ")}` : null,
    s.cliente ? `Cliente finale: ${s.cliente}` : null,
    s.mittente ? `Mittente: ${s.mittente}` : null,
    merce ? `Merce: ${merce}` : null,
    tappe.length > 2 ? `Tappe: ${tappe.join(" → ")}` : null,
    s.note || null,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
  return {
    // "Cliente" de una solicitud es el cliente final del envio; la empresa que lo manda es la ficha enlazada (empresaId).
    cliente: s.cliente || riga.remotoNome,
    destinazione: s.destinazione,
    fechaHora: new Date(s.eta ?? s.fechaServicio),
    ritiro: s.ritiro ?? null,
    pais: s.pais ?? null,
    shipment: s.shipment ?? s.codigo ?? null,
    orderNumero: s.orderNumero ?? null,
    // "Km pianificati" de la otra app: va a la columna km de la solicitud, de donde "Completar y aceptar" lo precarga (editable) en los km del servicio.
    km: s.km ?? null,
    descripcion: descripcion || null,
  };
};

// El codigo que manda la otra app sirve de codigo del servicio si nadie lo usa ya (si no, el interno de siempre).
const codigoLibre = async (codigo) => {
  const c = String(codigo ?? "").trim();
  if (!c || c.length > 100) return undefined;
  return (await prisma.record.findUnique({ where: { codigo: c }, select: { id: true } })) ? undefined : c;
};

const enCurso = new Set();

// Aviso de que hay una solicitud esperando en la bandeja (solo cuando no se pudo pasar sola al Registro, o con COLLEGAMENTI_AUTO_ACEPTAR=false).
const avisaSolicitudPendiente = (solicitud, nombreApp) =>
  ownerAndResponsableIds(solicitud.servicio, solicitud.zona)
    .then((ids) =>
      sendPushToUserIds(ids, { title: "Nueva entrega de app conectada", body: `${nombreApp}: ${solicitud.cliente} - ${solicitud.destinazione}`, data: { type: "solicitud", solicitudId: solicitud.id } })
    )
    .catch(() => {});

// Lo que llega de una app conectada (App Piazza) no espera en "Solicitudes": entra DIRECTO al Registro del dia, con chofer y vehiculo "Sin asignar" (el Responsable elige los
// reales en "Por asignar"), y a la otra app se le avisa enseguida que quedo aceptado (y despues, cuando se asignan chofer y vehiculo, su nombre y targa). La solicitud se
// conserva, ya ACEPTADA y enlazada al servicio, porque de ahi salen la linea de tiempo y los cambios que haga la otra app. Si el servicio no se puede crear, la solicitud
// queda pendiente (nada se pierde) y se avisa a la oficina como antes. No bloquea la respuesta a la otra app: se hace en segundo plano.
export const aceptarAutomaticamente = async (solicitudId) => {
  if (!env.COLLEGAMENTI_AUTO_ACEPTAR || enCurso.has(solicitudId)) return null;
  enCurso.add(solicitudId);
  let solicitud = null;
  try {
    solicitud = await prisma.solicitudServicio.findUnique({ where: { id: solicitudId }, include: { collegamento: { select: { remotoNome: true } } } });
    if (!solicitud || solicitud.estado !== "PENDIENTE" || !solicitud.collegamentoId) return null;
    const record = await crearServicioDirecto(solicitud, { codigoPreferido: await codigoLibre(solicitud.shipment) });
    const { count } = await prisma.solicitudServicio.updateMany({
      where: { id: solicitudId, estado: "PENDIENTE" },
      data: { estado: "ACEPTADA", recordId: record.id, revisadoAt: new Date(), motivoRechazo: null },
    });
    if (!count) return null;
    void notificaEsitoSolicitud(solicitud, "ACCETTATO");
    void ownerAndResponsableIds(solicitud.servicio, solicitud.zona).then((ids) => avisarServicioDirecto(solicitud, record, { cliente: { nombre: solicitud.collegamento?.remotoNome } }, ids));
    return record;
  } catch (err) {
    console.error("[collegamenti] no se pudo pasar al Registro, queda como solicitud pendiente:", err.message);
    if (solicitud) void avisaSolicitudPendiente(solicitud, solicitud.collegamento?.remotoNome ?? "App conectada");
    return null;
  } finally {
    enCurso.delete(solicitudId);
  }
};

// Al arrancar: las solicitudes de apps conectadas que quedaron pendientes (por ejemplo, las que llegaron antes de este cambio) pasan al Registro.
export const convertirSolicitudesConectadasPendientes = async () => {
  if (!env.COLLEGAMENTI_AUTO_ACEPTAR) return 0;
  await reconciliarAnuladosConectados().catch((err) => console.error("[collegamenti] fallo la reconciliacion de anulados:", err.message));
  await reclasificarServiciosConectados().catch((err) => console.error("[collegamenti] fallo la reclasificacion:", err.message));
  const pendientes = await prisma.solicitudServicio.findMany({ where: { estado: "PENDIENTE", collegamentoId: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true }, take: 100 });
  let convertidas = 0;
  for (const { id } of pendientes) if (await aceptarAutomaticamente(id)) convertidas += 1;
  if (convertidas > 0) console.log(`[collegamenti] ${convertidas} solicitud(es) de apps conectadas pasaron al Registro`);
  return convertidas;
};

// Servicios de apps conectadas que la otra app ya anulo (consta en su linea de tiempo) pero que siguen Pendientes aqui, porque la anulacion llego antes de que se
// pasara a Anulado solo: se ponen en Anulado. Se mira el ultimo hito de cada uno (si despues lo volvieron a asignar a Gamonal, no se toca).
export const reconciliarAnuladosConectados = async () => {
  const filas = await prisma.solicitudServicio.findMany({
    where: { collegamentoId: { not: null }, estado: "ACEPTADA", recordId: { not: null }, record: { estado: "IN_SOSPESO" } },
    select: { id: true, recordId: true },
    take: 300,
  });
  if (filas.length === 0) return 0;
  const hitos = await prisma.cambioServicio.findMany({
    where: { solicitudId: { in: filas.map((f) => f.id) }, campo: { in: ["app_annullata", "app_ricevuto"] } },
    orderBy: { createdAt: "desc" },
    select: { solicitudId: true, campo: true },
  });
  const ultimo = new Map();
  for (const h of hitos) if (!ultimo.has(h.solicitudId)) ultimo.set(h.solicitudId, h.campo);
  const anulados = filas.filter((f) => ultimo.get(f.id) === "app_annullata").map((f) => f.recordId);
  if (anulados.length === 0) return 0;
  const { count } = await prisma.record.updateMany({ where: { id: { in: anulados }, estado: "IN_SOSPESO" }, data: { estado: "ANNULLATO" } });
  if (count > 0) console.log(`[collegamenti] ${count} servicio(s) anulados por la app conectada pasaron a Anulado`);
  return count;
};

// Servicios de apps conectadas que ya estan en el Registro, todavia sin chofer ni vehiculo, pero con el tipo mal puesto (por ejemplo, un AB Service que entro como Extra Piazza
// antes de que el tipo se dedujera del texto): se corrigen con el mismo criterio. Los que ya tienen chofer o vehiculo, o ya salieron, no se tocan.
export const reclasificarServiciosConectados = async () => {
  const filas = await prisma.solicitudServicio.findMany({
    where: {
      collegamentoId: { not: null },
      estado: "ACEPTADA",
      recordId: { not: null },
      datosRemotos: { not: Prisma.DbNull },
      record: { estado: "IN_SOSPESO", driver: { correoElectronico: SIN_ASIGNAR_CORREO }, vehicle: { targa: SIN_ASIGNAR_TARGA } },
    },
    include: { record: { select: { id: true, codigo: true, spedizzione: true, extrasPiazzaZona: true } } },
    take: 200,
  });
  let corregidos = 0;
  for (const fila of filas) {
    try {
      const d = fila.datosRemotos;
      const tipo = detectarTipoServicio({
        cliente: d.app_cliente,
        shipment: d.app_shipment,
        orderNumero: d.app_order,
        codigo: d.app_codice,
        texto: [d.app_cliente, d.app_codice, d.app_shipment, d.app_order, d.app_mittente, d.app_ritiro, d.app_destinazione, ...(d.app_tappe ?? []), d.app_note].filter(Boolean).join("\n"),
      });
      const { servicio, zona } = tipoDeSolicitud(tipo, { ciudad: d.app_ciudad, destino: d.app_destinazione });
      const def = SOLICITUD_SERVICIOS[servicio];
      const zonaRecord = servicio === "EXTRA_PIAZZA" ? zona : def.zona;
      if (fila.servicio === servicio && fila.record.spedizzione === def.spedizzione && fila.record.extrasPiazzaZona === zonaRecord) continue;
      const conNumeros = servicio !== "EXTRA_PIAZZA";
      const codigo = /^[A-Z_]+-\d{10,}$/.test(fila.record.codigo) ? await codigoLibre(fila.shipment) : undefined;
      await prisma.record.update({
        where: { id: fila.record.id },
        data: {
          spedizzione: def.spedizzione,
          extrasPiazzaZona: zonaRecord,
          clientId: await resolverClientePorNombre(fila.cliente, { abService: servicio === "AB_SERVICE" }),
          shipment: conNumeros ? (fila.shipment ?? null) : null,
          orderNumero: conNumeros ? (fila.orderNumero ?? null) : null,
          ...(codigo ? { codigo } : {}),
        },
      });
      await prisma.solicitudServicio.update({ where: { id: fila.id }, data: { servicio, zona: servicio === "EXTRA_PIAZZA" ? zona : null } });
      corregidos += 1;
    } catch (err) {
      console.error(`[collegamenti] no se pudo reclasificar ${fila.id}:`, err.message);
    }
  }
  if (corregidos > 0) console.log(`[collegamenti] ${corregidos} servicio(s) de apps conectadas se reclasificaron por su texto`);
  return corregidos;
};

// Llega un servicio de la otra app: entra directo al Registro del dia sin chofer ni vehiculo (ver aceptarAutomaticamente). Si llega de nuevo (reenvio), se actualiza.
export const riceviServizio = async (riga, s) => {
  richiedeAttivo(riga);
  const dati = datiSolicitud(s, riga);
  const datosRemotos = normalizzaDati(s);
  const esistente = await prisma.solicitudServicio.findUnique({
    where: { collegamentoId_recordRemotoId: { collegamentoId: riga.id, recordRemotoId: s.recordId } },
    include: { record: { select: { id: true, codigo: true, shipment: true, spedizzione: true, extrasPiazzaZona: true, estado: true } } },
  });
  if (esistente) {
    // Cambios respecto de lo ultimo que mando la otra app (linea de tiempo del servicio + aviso a la oficina).
    const cambi = confronta(esistente.datosRemotos, datosRemotos);
    if (esistente.estado === "PENDIENTE") {
      await prisma.solicitudServicio.update({ where: { id: esistente.id }, data: { ...dati, datosRemotos } });
      await registraCambi({ riga, solicitud: esistente, cambi, tituloSolicitud: "Solicitud modificada por la app conectada" });
      void aceptarAutomaticamente(esistente.id);
    } else if (esistente.estado === "ACEPTADA") {
      // Si la otra app lo habia anulado (y por eso esta Anulado) y ahora lo vuelve a asignar a Gamonal, se reabre.
      if (esistente.record?.estado === "ANNULLATO") {
        const ultimo = await prisma.cambioServicio.findFirst({ where: { solicitudId: esistente.id, campo: { in: ["app_annullata", "app_ricevuto"] } }, orderBy: { createdAt: "desc" }, select: { campo: true } });
        if (ultimo?.campo === "app_annullata") {
          const { count } = await prisma.record.updateMany({ where: { id: esistente.record.id, estado: "ANNULLATO" }, data: { estado: "IN_SOSPESO" } });
          if (count > 0) await registraHito(riga, esistente.id, esistente.record.id, "app_ricevuto", `Reasignado por ${riga.remotoNome}: el servicio se reabrió`);
        }
      }
      // Ya esta en el registro: el servicio de Gamonal NO se toca; se anota que cambio y se avisa a la oficina.
      await prisma.solicitudServicio.update({ where: { id: esistente.id }, data: { datosRemotos } });
      await registraCambi({ riga, solicitud: esistente, record: esistente.record, cambi, tituloPush: "Servicio modificado por la app conectada" });
    } else if (esistente.estado === "RECHAZADA" && esistente.motivoRechazo?.startsWith("Annullata")) {
      // Quitado y luego reasignado a Gamonal: vuelve a "pendiente".
      await prisma.solicitudServicio.update({ where: { id: esistente.id }, data: { ...dati, datosRemotos, estado: "PENDIENTE", motivoRechazo: null, revisadoPorId: null, revisadoAt: null } });
      await registraHito(riga, esistente.id, null, "app_ricevuto", `Reasignado por ${riga.remotoNome}`);
      void aceptarAutomaticamente(esistente.id);
    } else if (!esistente.datosRemotos) {
      await prisma.solicitudServicio.update({ where: { id: esistente.id }, data: { datosRemotos } });
    }
    return { id: esistente.id };
  }
  // DHL, AB Service o Extra Piazza: lo dice el texto (cliente, palabras y forma de los numeros), igual que el lector de textos de la oficina.
  const tipoDetectado = detectarTipoServicio({ tipo: s.tipo, cliente: s.cliente, texto: textoDeServicio(s), shipment: s.shipment, orderNumero: s.orderNumero, codigo: s.codigo });
  const { servicio, zona } = tipoDeSolicitud(tipoDetectado, { ciudad: s.ciudad, destino: s.destinazione });
  let solicitud;
  try {
    solicitud = await prisma.solicitudServicio.create({
      data: {
        ...dati,
        datosRemotos,
        servicio,
        zona,
        fornitore: env.EMPRESA_NOMBRE,
        empresaId: riga.clientId,
        creadoPorId: await utenteDelCollegamento(riga),
        collegamentoId: riga.id,
        recordRemotoId: s.recordId,
      },
    });
  } catch (err) {
    // Dos envios iguales a la vez (la otra app reintenta): el segundo encuentra la fila que acaba de crear el primero y no hace nada mas.
    if (err?.code !== "P2002") throw err;
    const ya = await prisma.solicitudServicio.findUnique({ where: { collegamentoId_recordRemotoId: { collegamentoId: riga.id, recordRemotoId: s.recordId } }, select: { id: true } });
    if (!ya) throw err;
    return { id: ya.id };
  }
  await registraHito(riga, solicitud.id, null, "app_ricevuto", `Recibido de ${riga.remotoNome}`);
  // Directo al Registro (en segundo plano); con el interruptor apagado, a la bandeja de Solicitudes como antes.
  if (env.COLLEGAMENTI_AUTO_ACEPTAR) void aceptarAutomaticamente(solicitud.id);
  else void avisaSolicitudPendiente(solicitud, riga.remotoNome);
  return { id: solicitud.id };
};

export const riceviAnnullo = async (riga, recordRemotoId, { motivo } = {}) => {
  richiedeAttivo(riga);
  const solicitud = await prisma.solicitudServicio.findUnique({ where: { collegamentoId_recordRemotoId: { collegamentoId: riga.id, recordRemotoId } } });
  if (!solicitud) return { ok: true };
  const nome = riga.client?.nombre ?? riga.remotoNome;
  if (solicitud.estado === "PENDIENTE") {
    await prisma.solicitudServicio.update({
      where: { id: solicitud.id },
      data: { estado: "RECHAZADA", motivoRechazo: `Annullata da ${nome}${motivo ? `: ${motivo}` : ""}`, revisadoAt: new Date() },
    });
    await registraHito(riga, solicitud.id, null, "app_annullata", `Anulado por ${riga.remotoNome}${motivo ? `: ${motivo}` : ""}`);
  } else if (solicitud.estado === "ACEPTADA" && solicitud.recordId) {
    // El servicio ya esta en el Registro. Si todavia no salio (Pendiente), pasa a Anulado como lo hizo la otra app (eliminarlo o anularlo alla es lo mismo); si ya salio
    // (retirado, en camino o entregado) NO se toca: no se puede anular algo que ya se hizo, asi que solo queda en la linea de tiempo y se avisa a la oficina (alerta + push).
    const record = await prisma.record.findUnique({
      where: { id: solicitud.recordId },
      select: { id: true, codigo: true, shipment: true, spedizzione: true, extrasPiazzaZona: true, estado: true, driverId: true, driver: { select: { correoElectronico: true } } },
    });
    if (record) {
      const { count } = await prisma.record.updateMany({ where: { id: record.id, estado: "IN_SOSPESO" }, data: { estado: "ANNULLATO" } });
      const anulado = count > 0;
      const quien = `Anulado por ${riga.remotoNome}${motivo ? `: ${motivo}` : ""}`;
      await registraCambi({
        riga,
        solicitud,
        record,
        cambi: [{ campo: "app_annullata", anteriorVisible: null, nuevoVisible: anulado ? `${quien} (el servicio pasó a Anulado)` : `${quien} (el servicio ya había salido: revísalo)` }],
        tituloPush: anulado ? "Servicio anulado por la app conectada" : "Servicio anulado por la app conectada, pero ya habia salido",
      });
      // El chofer que ya lo tenia asignado se entera.
      if (anulado && record.driver?.correoElectronico !== SIN_ASIGNAR_CORREO) {
        void sendPushToUserIds([record.driverId], { title: "Servicio anulado", body: `${record.codigo} fue anulado por ${riga.remotoNome}.`, data: { type: "record", recordId: record.id } }).catch(() => {});
      }
    }
  }
  return { ok: true };
};
