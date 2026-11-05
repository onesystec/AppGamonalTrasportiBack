import { z } from "zod";
import { SOLICITUD_SERVICIO_KEYS } from "../constants/solicitudes.js";
import { romeLocalToDate } from "../utils/romeTime.js";

const APLICATIVO_VALUES = [
  ...Array.from({ length: 18 }, (_, i) => `MILANO_${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ROMA_${i + 1}`),
];

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const emptyToNull = (value) => (value === undefined || (typeof value === "string" && value.trim() === "") ? null : value);

// El formulario manda la hora "de pared" sin zona (AAAA-MM-DDTHH:mm): se interpreta como hora de Roma, igual que en los servicios.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const romeWallClock = (value) =>
  typeof value === "string" && WALL_CLOCK.test(value) ? romeLocalToDate(value.slice(0, 10), value.slice(11, 16)) : value;

const text = (label, max) =>
  z.string({ required_error: `${label}: campo obbligatorio` }).trim().min(1, `${label}: campo obbligatorio`).max(max, `${label}: testo troppo lungo`);
const optionalText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max, "Testo troppo lungo").nullable());
const optionalNumber = (label) =>
  z.preprocess(emptyToNull, z.coerce.number({ invalid_type_error: `${label} non valido` }).min(0, `${label} non valido`).max(1e6, `${label} non valido`).nullable());

// KM destino: un numero ("25", "25 KM", "68,5") va a km; cualquier otro texto ("NAVETTA HP") queda como kmTexto y km sin valor.
const KM_NUMERO = /^\s*(\d+(?:[.,]\d+)?)\s*(?:km)?\s*$/i;
const splitKm = (value) => {
  if (value === undefined || value === null) return { km: null, kmTexto: null };
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? { km: value, kmTexto: null } : { km: null, kmTexto: null };
  const text = String(value).trim();
  if (!text) return { km: null, kmTexto: null };
  const match = KM_NUMERO.exec(text);
  if (match) return { km: Number(match[1].replace(",", ".")), kmTexto: null };
  return { km: null, kmTexto: text.slice(0, 100) };
};
const applyKm = ({ km, ...rest }, hasKm) => (hasKm ? { ...rest, ...splitKm(km) } : rest);

const boolean = z.preprocess((v) => (v === "true" || v === "on" ? true : v === "false" ? false : v), z.boolean());


// Extra Piazza Milano o Roma (cada una sale de su lugar de espera); en los demas tipos se ignora.
const zonaExtra = z.preprocess(emptyToNull, z.enum(["MILANO", "ROMA"], { errorMap: () => ({ message: "Zona non valida (Milano o Roma)" }) }).nullable().optional());

const fields = {
  zona: zonaExtra,
  servicio: z.enum(SOLICITUD_SERVICIO_KEYS, { errorMap: () => ({ message: "Scegli il tipo di servizio" }) }),
  // En Extra Piazza el cliente puede quedar vacio (lo pone la oficina al aceptar): se exige en los demas servicios (ver clienteObligatorio).
  cliente: z.string({ required_error: "Il cliente è obbligatorio" }).trim().max(150, "Il cliente è troppo lungo"),
  destinazione: text("La destinazione", 250),
  fechaHora: z.preprocess(romeWallClock, z.coerce.date({ errorMap: () => ({ message: "La data e l'ora non sono valide" }) })),
  km: z.union([z.string(), z.number(), z.null()]).optional(),
  pagato: optionalNumber("L'importo pagato"),
  pagato50: boolean,
  fornitore: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? "Gamonal" : v), z.string().trim().max(100, "Il fornitore è troppo lungo").default("Gamonal")),
  autRitiro: optionalText(100),
  varie: optionalText(500),
  varie2: optionalNumber("Varie 2"),
  descripcion: optionalText(4000),
  aplicativo: z.preprocess(emptyToNull, z.enum(APLICATIVO_VALUES, { errorMap: () => ({ message: "Numero non valido" }) }).nullable()),
  // Chofer que indica el cliente (opcional, texto libre).
  choferIndicado: optionalText(100),
  // Extra Piazza: lugar de retiro.
  ritiro: optionalText(250),
  // DHL Milano: lo que se lee del texto del portal de DHL (Shipment, Order y tipo ASAP / SCHEDULED).
  shipment: optionalText(60),
  orderNumero: optionalText(60),
  tipoPedido: z.preprocess(emptyToNull, z.enum(["ASAP", "SCHEDULED"], { errorMap: () => ({ message: "Tipo non valido (ASAP o SCHEDULED)" }) }).nullable()),
};

// El cliente es obligatorio salvo en Extra Piazza (si se sabe el servicio; en una edicion parcial sin servicio no se revisa).
const clienteObligatorio = (data, ctx) => {
  if (data.servicio && data.servicio !== "EXTRA_PIAZZA" && "cliente" in data && !data.cliente) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cliente"], message: "Il cliente è obbligatorio" });
  }
};

export const createSolicitudSchema = z
  .object({ ...fields, pagato50: boolean.default(false) })
  .superRefine(clienteObligatorio)
  .transform((data) => applyKm(data, true));
export const updateSolicitudSchema = z
  .object(fields)
  .partial()
  .superRefine(clienteObligatorio)
  .refine((v) => Object.keys(v).length > 0, { message: "Nessuna modifica" })
  .transform((data) => applyKm(data, "km" in data));

export const solicitudIdSchema = z.object({ id: z.string().uuid("Id non valido") });

export const clienteSolicitudesQuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mese non valido (usa AAAA-MM)").optional()),
});

export const listSolicitudesQuerySchema = z.object({
  estado: z.preprocess(emptyToUndefined, z.enum(["PENDIENTE", "ACEPTADA", "RECHAZADA", "TODAS"]).default("PENDIENTE")),
});

export const rechazarSolicitudSchema = z.object({
  motivo: z.preprocess(emptyToNull, z.string().trim().max(500, "El motivo es demasiado largo").nullable()),
});

// Servicio desde un texto pegado (DHL Milano, DHL Roma, AB Service y Extra Piazza; Extras Stefania todavia no). Todo este proceso va en italiano.
const SERVICIOS_DESDE_TEXTO = ["DHL_MILANO", "DHL_ROMA", "AB_SERVICE", "EXTRA_PIAZZA"];
const servizioDaTesto = z.enum(SERVICIOS_DESDE_TEXTO, { errorMap: () => ({ message: "Questo tipo di servizio non si carica ancora da un testo" }) });
const testoObbligatorio = (label, max, femminile = false) =>
  z
    .string({ required_error: `${label} è ${femminile ? "obbligatoria" : "obbligatorio"}` })
    .trim()
    .min(1, `${label} è ${femminile ? "obbligatoria" : "obbligatorio"}`)
    .max(max, `${label} è ${femminile ? "troppo lunga" : "troppo lungo"}`);

// Leer un texto: DHL Milano, DHL Roma, AB Service y Extra Piazza. (Crear la solicitud pendiente desde la oficina: solo DHL Milano y DHL Roma.)
const servizioLeggibile = z.enum(["DHL_MILANO", "DHL_ROMA", "AB_SERVICE", "EXTRA_PIAZZA"], { errorMap: () => ({ message: "Questo tipo di servizio non si carica ancora da un testo" }) });

export const leerTextoSchema = z.object({ servicio: servizioLeggibile, zona: zonaExtra, texto: testoObbligatorio("Il testo", 20000) });

// Cliente (Piazza): registrar un servicio pegando solo el texto (se lee y se crea de una vez). confirmar: crearlo aunque ya haya uno con el mismo Shipment / Order.
export const registrarDesdeTextoClienteSchema = z.object({
  servicio: z.enum(SOLICITUD_SERVICIO_KEYS, { errorMap: () => ({ message: "Scegli il tipo di servizio" }) }),
  zona: zonaExtra,
  // Dia pedido desde Disponibilita (AAAA-MM-DD): si el texto no trae la ETA, la solicitud queda en ese dia.
  fecha: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida").optional()),
  texto: testoObbligatorio("Il testo", 20000),
  confirmar: z.boolean().optional(),
});

export const crearDesdeTextoSchema = z
  .object({
  servicio: servizioDaTesto,
  zona: zonaExtra,
  // El cliente es obligatorio salvo en Extra Piazza (lo pone la oficina al aceptar).
  cliente: z.string().trim().max(150, "Il cliente è troppo lungo").default(""),
  destinazione: testoObbligatorio("La città", 250, true),
  fechaHora: z.preprocess(romeWallClock, z.coerce.date({ errorMap: () => ({ message: "La data e l'ora non sono valide" }) })),
  // El texto completo pegado.
  descripcion: testoObbligatorio("Il testo", 20000),
  shipment: optionalText(60),
  orderNumero: optionalText(60),
  tipoPedido: z.preprocess(emptyToNull, z.enum(["ASAP", "SCHEDULED"], { errorMap: () => ({ message: "Tipo non valido (ASAP o SCHEDULED)" }) }).nullable()),
  // Calle y CAP de la entrega (Ship To Address / Ship To Postal Code).
  calle: optionalText(250),
  cap: optionalText(20),
  // Pais de la entrega (codigo ISO de 2 letras; vacio = Italia).
  pais: z.preprocess(emptyToNull, z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Paese non valido").nullable()),
  aplicativo: fields.aplicativo,
  // Extra Piazza: donde se retira; AB Service: km si el texto los trae.
  ritiro: fields.ritiro,
  km: z.preprocess(emptyToNull, z.coerce.number().min(0, "I km non sono validi").max(1e6, "I km non sono validi").nullable()),
  })
  .superRefine((d, ctx) => {
    if (d.servicio !== "EXTRA_PIAZZA" && !d.cliente) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cliente"], message: "Il cliente è obbligatorio" });
  });
