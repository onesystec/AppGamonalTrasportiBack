import { romeDay, romeLocalToDate } from "../utils/romeTime.js";

// Lector de textos de servicio (DHL Milano): un texto pegado -> los datos que se pueden sacar SOLO con reglas, sin IA y sin costo.
// Entiende dos formas de texto:
//  - El del portal de DHL ("Shipment # 171712939 / Customer EMC2 / Ship To City VIZZOLA TICINO / ETA 2026-Oct-31 00:44:30 (+01:00) ..."),
//    con las etiquetas a veces partidas en dos lineas y con caracteres invisibles dentro de las fechas y los codigos.
//  - El mensaje interno de la oficina ("MEDTRONIC ASAP CON APP / MILANO 12 / PER BRESCIA / ETA ORE 13.40 / ORDER ... / SHIPMENT ...").
// Devuelve solo lo que encontro (null en lo demas) y una lista de avisos para quien revisa. No decide nada: lo demas lo completa la persona.

// Marcas invisibles que traen los textos copiados (guion blando, ancho cero, aislantes de direccion, BOM) y espacios raros.
const INVISIBLES = new RegExp("[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]", "g");

export const cleanText = (text) =>
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLES, "")
    .replace(new RegExp("[\u00A0\u2007\u202F]", "g"), " ")
    .trim();

// Etiquetas del portal: sirven para saber donde termina un valor de varias palabras (ej. el cliente).
const LABELS =
  "Shipment|From Warehouse|Warehouse|ETA|Mobile Phone|Ship To|Shipment lines|Part ID|Orders?|Service Type|Service Level|Reference|Customer|Bin Loc|Line Qty|Suggest LPN";
const NEXT_LABEL = `(?=\\s(?:${LABELS})\\b|$)`;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTHS_IT = { gen: 1, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, dic: 12 };

// Nombres de ciudad en ingles que el portal pone distinto de como se escribe en Italia.
const CITY_IT = {
  rome: "Roma",
  milan: "Milano",
  turin: "Torino",
  florence: "Firenze",
  venice: "Venezia",
  naples: "Napoli",
  genoa: "Genova",
  padua: "Padova",
  mantua: "Mantova",
};

// Para comparar nombres: sin mayusculas, acentos ni signos.
const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep, ch) => `${sep}${ch.toUpperCase()}`)
    .replace(/\s+/g, " ")
    .trim();

const cityName = (raw) => {
  const clean = raw.replace(/[*_]/g, "").trim();
  return CITY_IT[clean.toLowerCase()] ?? titleCase(clean);
};

const pad = (n) => String(n).padStart(2, "0");

// Hora de pared de Roma (o, si el texto trae el desfase "(+01:00)", ese desfase) -> el instante.
const toInstant = ({ year, month, day, hour, minute, offset }, now) => {
  const dayStr = `${year}-${pad(month)}-${pad(day)}`;
  if (!offset) return romeLocalToDate(dayStr, `${pad(hour)}:${pad(minute)}`);
  const sign = offset.startsWith("-") ? -1 : 1;
  const [oh, om] = offset.slice(1).split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - sign * (oh * 60 + (om || 0)) * 60000);
};

const WEEKDAYS = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const WEEKDAY_NAMES = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

// Dia de una ETA que solo trae la hora: "PER LUNEDI" (el proximo lunes; si hoy es lunes, hoy), "DOMANI" (mañana) o, sin nada, hoy.
const assumedDay = (flat, now) => {
  const today = romeDay(now);
  const [y, mo, d] = today.split("-").map(Number);
  const plain = flat.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const addDays = (n) => {
    const date = new Date(Date.UTC(y, mo - 1, d + n));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  };
  const weekday = /\bper\s+(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b/.exec(plain);
  if (weekday) {
    const todayWeekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const diff = (WEEKDAYS[weekday[1]] - todayWeekday + 7) % 7;
    const day = addDays(diff);
    return { day, label: `il prossimo ${WEEKDAY_NAMES[WEEKDAYS[weekday[1]]]} (${day.slice(8)}/${day.slice(5, 7)}), secondo il testo` };
  }
  if (/\bdomani\b/.test(plain)) return { day: addDays(1), label: "domani, perché il testo dice DOMANI" };
  return { day: today, label: "oggi" };
};

const findEta = (flat, now, avisos) => {
  // Portal: "ETA 2026-Oct-31 00:44:30 (+01:00)" (tambien "2026-10-31 09:00" y "31/10/2026 09:00").
  let m = /\bETA\s*[:=]?\s*(\d{4})[-/\s]*([A-Za-z]{3})[A-Za-z]*[-/\s]*(\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:\(?\s*([+-]\d{2}:?\d{2})\s*\)?)?/i.exec(flat);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()] ?? MONTHS_IT[m[2].toLowerCase()];
    if (month) {
      const offset = m[6] ? `${m[6].slice(0, 3)}:${m[6].slice(-2)}` : null;
      return toInstant({ year: +m[1], month, day: +m[3], hour: +m[4], minute: +m[5], offset }, now);
    }
  }
  m = /\bETA\s*[:=]?\s*(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{2})/i.exec(flat);
  if (m) return toInstant({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, now);
  m = /\bETA\s*[:=]?\s*(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s+(\d{1,2}):(\d{2})/i.exec(flat);
  if (m) return toInstant({ year: +m[3], month: +m[2], day: +m[1], hour: +m[4], minute: +m[5] }, now);

  // Mensaje interno: "ETA ORE 13.40", "ETA ORE 11", "ETA H.8", "ETA 19.45", "ETA 08:00" (solo la hora; opcional "DEL 31/10").
  m = /\bETA\s*[:=]?\s*(?:ORE|H\.?)?\s*(\d{1,2})(?!\d)(?:\s*[.:h]\s*(\d{2}))?(?:\s+DEL\s+(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?)?/i.exec(flat);
  if (m && +m[1] <= 23) {
    const today = romeDay(now);
    const [ty] = today.split("-").map(Number);
    let day = today;
    if (m[3]) {
      const year = m[5] ? (m[5].length === 2 ? 2000 + +m[5] : +m[5]) : ty;
      day = `${year}-${pad(+m[4])}-${pad(+m[3])}`;
    } else {
      const assumed = assumedDay(flat, now);
      day = assumed.day;
      avisos.push(`L'ETA contiene solo l'ora: si è supposto ${assumed.label}.`);
    }
    return romeLocalToDate(day, `${pad(+m[1])}:${m[2] ?? "00"}`);
  }
  return null;
};

const findCity = (flat, lines) => {
  // Portal: "Ship To City VIZZOLA TICINO" (hasta la siguiente etiqueta). Variante corta: "CITY X".
  let m = new RegExp(`\\bShip To City\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat);
  if (m && m[1].trim()) return cityName(m[1]);
  m = /(?:^|\n)\s*CITY\s*[:=]?\s+([^\n]+)/i.exec(lines);
  if (m && m[1].trim()) return cityName(m[1]);
  // Mensaje interno: la linea "PER BRESCIA".
  m = /(?:^|\n)\s*PER\s+([^\n]+)/i.exec(lines);
  if (m && m[1].trim() && !new RegExp(`^${TIPO_WORD}\\b|^(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\\b`, "i").test(m[1].normalize("NFD").replace(/\p{M}/gu, "").trim())) {
    return cityName(m[1]);
  }
  const sinPer = findClienteMensaje(lines).ciudad;
  return sinPer ? cityName(sinPer) : null;
};

const findTipo = (flat, avisos) => {
  const level = new RegExp(`\\bService Level\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat);
  if (level) {
    const value = level[1].trim();
    if (/^asap\b/i.test(value)) return "ASAP";
    if (/^schedul/i.test(value)) return "SCHEDULED";
    avisos.push(`Service Level "${value}": non è né ASAP né SCHEDULED, il tipo resta da completare.`);
    return null;
  }
  const word = /\b(ASAP|SCHEDULAT[OA]|SCHEDULED?)\b/i.exec(flat);
  if (word) return /^asap$/i.test(word[1]) ? "ASAP" : "SCHEDULED";
  return null;
};

const TIPO_WORD = "(?:ASAP|SCHEDULAT[OA]|SCHEDULED?)";
// Lineas que son otro dato del mensaje (no el cliente ni la ciudad): "PER ...", ETA, KM, RITIRO, ORDER, SHIPMENT, "A CHI ASSEGNO?", "3 PARTI",
// la zona ("MILANO", "MILANO 12", "ROMA") o cualquier linea que empiece con un numero.
const ES_OTRO_DATO = /^(?:per\b|eta\b|km\b|ritiro\b|order\b|shipment\b|a chi\b|chi\b|che\b|team\b|ciao\b|buon|(?:milano|roma)(?:\s+\d{1,2})?$|\d)/i;

// Lineas del mensaje interno sin las menciones ("@Romario GT") ni el formato (*negrita*).
const messageLines = (lines) =>
  lines
    .split("\n")
    .map((l) => l.replace(/[*_]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l && !l.startsWith("@"));

// Cliente y ciudad de un mensaje interno. Dos formas:
//  - "HP ASAP CON APP" / "MEDTRONIC SCHEDULED CON APP": el cliente va antes de ASAP/SCHEDULED y la ciudad en "PER <lugar>".
//  - "NUOVO SERVIZIO ASAP" / "NUOVO SERVIZIO SCHEDULATO PER LUNEDI": el cliente es la linea siguiente y la ciudad la que sigue al cliente
//    (si esa linea es la zona "MILANO" o un dato, no hay ciudad).
const findClienteMensaje = (lines) => {
  const all = messageLines(lines).slice(0, 8);
  for (let i = 0; i < all.length; i += 1) {
    const m = new RegExp(`^(.+?)\\s+${TIPO_WORD}\\b`, "i").exec(all[i]);
    if (!m) continue;
    const candidate = m[1].trim();
    if (!/^(nuovo|new)\b/i.test(candidate)) return { cliente: candidate, ciudad: null };
    const cliente = all[i + 1] && !ES_OTRO_DATO.test(all[i + 1]) ? all[i + 1] : null;
    const next = cliente ? all[i + 2] : null;
    return { cliente, ciudad: next && !ES_OTRO_DATO.test(next) ? next : null };
  }
  return { cliente: null, ciudad: null };
};

// Cliente: "Customer EMC2" (portal) o el del mensaje interno.
const findCliente = (flat, lines) => {
  const m = new RegExp(`\\bCustomer\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat);
  if (m && m[1].trim()) return m[1].trim();
  return findClienteMensaje(lines).cliente;
};

// Si el texto no dice el tipo (el portal casi nunca trae "Service Level") se deduce de lo lejos que queda la ETA: hasta ASAP_MAX_HORAS desde ahora
// es ASAP (urgente) y mas alla, SCHEDULED (programado para otro momento). Con la ETA ya pasada (mas de una hora) no se puede saber. Es solo una
// sugerencia: en la pantalla se puede cambiar.
const ASAP_MAX_HORAS = 8;
const deducirTipo = (eta, now) => {
  const horas = (eta.getTime() - now.getTime()) / 3600000;
  if (horas < -1) return { tipo: null, horas };
  return { tipo: horas <= ASAP_MAX_HORAS ? "ASAP" : "SCHEDULED", horas };
};

// Cliente del texto -> el de tu lista (por nombre; sin diferencias de mayusculas, acentos ni espacios). null si no hay uno claro.
export const matchClient = (name, clients) => {
  if (!name) return null;
  const wanted = norm(name);
  if (!wanted) return null;
  const exact = clients.find((c) => norm(c.nombre) === wanted);
  if (exact) return exact;
  // "EMC2 ITALIA" vs "EMC2": uno contiene al otro como palabras completas, y solo si es unico.
  const contained = clients.filter((c) => {
    const n = norm(c.nombre);
    return n && (` ${n} `.includes(` ${wanted} `) || ` ${wanted} `.includes(` ${n} `));
  });
  return contained.length === 1 ? contained[0] : null;
};

// text: el texto pegado. clients: [{ id, nombre }] (para reconocer al cliente). now: para completar la fecha cuando solo viene la hora.
export const parseServicioTexto = (text, { clients = [], now = new Date() } = {}) => {
  const avisos = [];
  const lines = cleanText(text);
  const flat = ` ${lines.replace(/\s+/g, " ")} `;

  const shipment = /\bShipment\s*#?\s*[:.]?\s*(\d{6,})/i.exec(flat)?.[1] ?? null;
  const orderNumero = /\bOrder\s*#?\s*[:.]?\s*(\d{6,})/i.exec(flat)?.[1] ?? null;
  const clienteTexto = findCliente(flat, lines);
  const client = matchClient(clienteTexto, clients);
  const tipoPedido = findTipo(flat, avisos);
  const ciudad = findCity(flat, lines);
  const eta = findEta(flat, now, avisos);

  // Tipo: el que dice el texto o, si no lo dice, el deducido de la ETA ("tipoOrigen": de donde sale).
  let tipo = tipoPedido;
  let tipoOrigen = tipoPedido ? "texto" : null;
  if (!tipo && eta) {
    const deducido = deducirTipo(eta, now);
    if (deducido.tipo) {
      tipo = deducido.tipo;
      tipoOrigen = "eta";
      avisos.push(`Il tipo non è nel testo: dedotto ${tipo} perché l'ETA è ${deducido.horas < 1 ? "tra meno di 1 h" : `tra ${Math.round(deducido.horas)} h`}. Cambialo se non è così.`);
    } else {
      avisos.push("Il tipo non è nel testo e l'ETA è già passata: non si può dedurre (ASAP o SCHEDULED).");
    }
  }

  if (!shipment) avisos.push("Shipment non trovato.");
  if (!orderNumero) avisos.push("Order non trovato.");
  if (!clienteTexto) avisos.push("Cliente non trovato.");
  else if (!client && clients.length) avisos.push(`Il cliente "${clienteTexto}" non esiste nella tua lista: scegline uno o crealo prima di accettare.`);
  if (!tipo && !eta) avisos.push("Tipo (ASAP o SCHEDULED) non trovato.");
  if (!ciudad) avisos.push("Città non trovata.");
  if (!eta) avisos.push("ETA non trovata.");

  return {
    descripcion: lines,
    shipment,
    orderNumero,
    cliente: client?.nombre ?? clienteTexto,
    clienteId: client?.id ?? null,
    tipoPedido: tipo,
    tipoOrigen,
    ciudad,
    eta,
    avisos,
  };
};
