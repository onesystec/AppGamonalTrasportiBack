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

  // Mensaje interno: "ETA ORE 13.40" (solo la hora; opcional "DEL 31/10"). La fecha se supone hoy y se avisa.
  m = /\bETA\s*(?:ORE|H|:)?\s*(\d{1,2})\s*[.:h]\s*(\d{2})(?:\s+DEL\s+(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?)?/i.exec(flat);
  if (m) {
    const today = romeDay(now);
    const [ty] = today.split("-").map(Number);
    let day = today;
    if (m[3]) {
      const year = m[5] ? (m[5].length === 2 ? 2000 + +m[5] : +m[5]) : ty;
      day = `${year}-${pad(+m[4])}-${pad(+m[3])}`;
    } else {
      avisos.push("La ETA solo trae la hora: se supuso el día de hoy.");
    }
    return romeLocalToDate(day, `${pad(+m[1])}:${m[2]}`);
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
  if (m && m[1].trim()) return cityName(m[1]);
  return null;
};

const findTipo = (flat, avisos) => {
  const level = new RegExp(`\\bService Level\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat);
  if (level) {
    const value = level[1].trim();
    if (/^asap\b/i.test(value)) return "ASAP";
    if (/^schedul/i.test(value)) return "SCHEDULED";
    avisos.push(`Service Level "${value}": no es ASAP ni SCHEDULED, el tipo queda para completar.`);
    return null;
  }
  const word = /\b(ASAP|SCHEDULED?)\b/i.exec(flat);
  if (word) return /^asap$/i.test(word[1]) ? "ASAP" : "SCHEDULED";
  return null;
};

// Cliente: "Customer EMC2" (portal) o, en el mensaje interno, lo que va antes de ASAP/SCHEDULED en la primera linea con texto.
const findCliente = (flat, lines) => {
  const m = new RegExp(`\\bCustomer\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat);
  if (m && m[1].trim()) return m[1].trim();
  // Las primeras lineas con texto (las que empiezan con "@" son las menciones a la oficina, no el pedido).
  const head = lines
    .split("\n")
    .map((l) => l.replace(/[*_]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l && !l.startsWith("@"))
    .slice(0, 4);
  for (const line of head) {
    const m = /^(.+?)\s+(?:ASAP|SCHEDULED?)\b/i.exec(line);
    if (!m) continue;
    const candidate = m[1].trim();
    // "NUOVO SERVIZIO ASAP" describe el pedido, no es un cliente.
    return /^(nuovo|new)\b/i.test(candidate) ? null : candidate;
  }
  return null;
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

  if (!shipment) avisos.push("No se encontró el Shipment.");
  if (!orderNumero) avisos.push("No se encontró el Order.");
  if (!clienteTexto) avisos.push("No se encontró el cliente.");
  else if (!client && clients.length) avisos.push(`El cliente "${clienteTexto}" no existe en tu lista: elige uno o créalo antes de aceptar.`);
  if (!tipoPedido && !avisos.some((a) => a.startsWith("Service Level"))) avisos.push("No se encontró el tipo (ASAP o SCHEDULED).");
  if (!ciudad) avisos.push("No se encontró la ciudad.");
  if (!eta) avisos.push("No se encontró la ETA.");

  return {
    descripcion: lines,
    shipment,
    orderNumero,
    cliente: client?.nombre ?? clienteTexto,
    clienteId: client?.id ?? null,
    tipoPedido,
    ciudad,
    eta,
    avisos,
  };
};
