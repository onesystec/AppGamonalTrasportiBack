import { prisma } from "../config/prisma.js";
import { registrarAlerta } from "./cambioCelda.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { ownerAndResponsableIds } from "./solicitud.service.js";

// Cambios que la app conectada (App Piazza) hace en un servicio DESPUES de mandarlo. Piazza vuelve a mandar el servicio completo (/servizi); aqui se compara con lo
// ultimo que mando (SolicitudServicio.datosRemotos) y de cada diferencia queda:
//  - una linea en la linea de tiempo del servicio (CambioServicio: se ve en la solicitud y, ya aceptado, en el detalle del servicio);
//  - un aviso a la oficina: alerta en "Cambios" + push si el servicio ya esta en el registro; push si todavia esta por aceptar.
// El servicio de Gamonal NO se modifica solo: la oficina ve que cambio y decide.

// campo -> nombre del dato (ver labelDeCampo en cambioCelda.service.js). "Recibido" y "Anulado" son los hitos de la linea de tiempo.
export const CAMPOS_REMOTOS = [
  "app_codice", "app_cliente", "app_destinazione", "app_ritiro", "app_tappe", "app_ciudad", "app_pais", "app_fecha",
  "app_shipment", "app_order", "app_km", "app_peso", "app_misure", "app_colli", "app_mittente", "app_note",
];

const texto = (v) => {
  const t = typeof v === "string" ? v.trim() : v;
  return t === "" || t == null ? null : String(t);
};

// El servicio tal como lo manda la otra app, reducido a datos simples y comparables (se guarda en datosRemotos).
export const normalizzaDati = (s) => ({
  app_codice: texto(s.codigo),
  app_cliente: texto(s.cliente),
  app_destinazione: texto(s.destinazione),
  app_ritiro: texto(s.ritiro),
  app_tappe: (s.tappe ?? []).map(texto).filter(Boolean),
  app_ciudad: texto(s.ciudad),
  app_pais: texto(s.pais),
  app_fecha: s.eta || s.fechaServicio ? new Date(s.eta ?? s.fechaServicio).toISOString() : null,
  app_shipment: texto(s.shipment),
  app_order: texto(s.orderNumero),
  app_km: s.km == null ? null : String(s.km),
  app_peso: s.pesoKg == null ? null : String(s.pesoKg),
  app_misure: texto(s.dimensioni),
  app_colli: s.colli == null ? null : String(s.colli),
  app_mittente: texto(s.mittente),
  app_note: texto(s.note),
});

const FECHA = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fechaCorta = (iso) => {
  const p = Object.fromEntries(FECHA.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};

const visible = (campo, valor) => {
  if (valor == null || (Array.isArray(valor) && valor.length === 0)) return null;
  if (campo === "app_fecha") return fechaCorta(valor);
  if (campo === "app_peso") return `${valor} kg`;
  if (campo === "app_km") return `${valor} km`;
  if (Array.isArray(valor)) return valor.join(" → ");
  const t = String(valor);
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
};

// Diferencias entre lo ultimo que mando la otra app y lo que manda ahora: [{ campo, anteriorVisible, nuevoVisible }]. Sin "antes" (servicio recibido antes de
// que existiera este registro) no hay nada que comparar.
export const confronta = (prima, dopo) => {
  if (!prima) return [];
  const cambi = [];
  for (const campo of CAMPOS_REMOTOS) {
    const a = prima[campo] ?? null;
    const b = dopo[campo] ?? null;
    // Con una o dos paradas son el ritiro y la entrega (ya se avisan como tales): las paradas solo cuentan en un giro con mas.
    if (campo === "app_tappe" && (a?.length ?? 0) <= 2 && (b?.length ?? 0) <= 2) continue;
    if (JSON.stringify(a ?? (Array.isArray(b) ? [] : null)) === JSON.stringify(b)) continue;
    cambi.push({ campo, anteriorVisible: visible(campo, a), nuevoVisible: visible(campo, b) });
  }
  return cambi;
};

// Anota en la linea de tiempo del servicio (solicitud y, si ya existe, su servicio) quien cambio que.
const anota = (riga, solicitudId, recordId, cambi) =>
  prisma.cambioServicio.createMany({
    data: cambi.map((c) => ({ solicitudId, recordId: recordId ?? null, campo: c.campo, anterior: c.anteriorVisible, nuevo: c.nuevoVisible, editorId: riga.id, editorNombre: riga.remotoNome })),
  });

// cambi: [{ campo, anteriorVisible, nuevoVisible }]. Con record (ya aceptado) hay alerta en "Cambios" y push; sin record (por aceptar) solo push.
// aviso = { titulo } para el push de una solicitud por aceptar. Nunca rompe la operacion que lo origina.
export const registraCambi = async ({ riga, solicitud, record = null, cambi, tituloPush, tituloSolicitud }) => {
  if (!cambi.length) return;
  try {
    await anota(riga, solicitud.id, record?.id, cambi);
    if (record) {
      await registrarAlerta({ id: riga.id, nombre: riga.remotoNome, apellido: "" }, record, cambi, tituloPush);
      return;
    }
    const ids = await ownerAndResponsableIds(solicitud.servicio, solicitud.zona);
    const una = (c) => `${c.campo}: ${c.anteriorVisible ?? "—"} → ${c.nuevoVisible ?? "—"}`;
    await sendPushToUserIds(ids, {
      title: tituloSolicitud,
      body: `${riga.remotoNome} cambio ${solicitud.cliente} - ${solicitud.destinazione} (${cambi.length === 1 ? una(cambi[0]) : `${cambi.length} cambios`}). Mira la solicitud.`.slice(0, 220),
      data: { type: "solicitud", solicitudId: solicitud.id },
    });
  } catch (err) {
    console.error("[collegamenti] no se pudo anotar el cambio:", err.message);
  }
};

// Hito de la linea de tiempo (Recibido / Anulado / Reasignado): una sola linea, sin comparar nada.
export const registraHito = (riga, solicitudId, recordId, campo, nuevo) =>
  anota(riga, solicitudId, recordId, [{ campo, anteriorVisible: null, nuevoVisible: nuevo }]).catch((err) => console.error("[collegamenti] no se pudo anotar el hito:", err.message));
