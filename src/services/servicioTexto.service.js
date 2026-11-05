import { romeDay, romeLocalToDate } from "../utils/romeTime.js";

// Lector de textos de servicio (DHL Milano, DHL Roma, AB Service y Extra Piazza): un texto pegado -> los datos que se pueden sacar SOLO con reglas, sin IA y sin costo.
// Entiende dos formas de texto:
//  - El del portal de DHL ("Shipment # 171712939 / Customer EMC2 / Ship To City VIZZOLA TICINO / ETA 2026-Oct-31 00:44:30 (+01:00) ..."),
//    con las etiquetas a veces partidas en dos lineas y con caracteres invisibles dentro de las fechas y los codigos.
//  - El mensaje interno de la oficina ("MEDTRONIC ASAP CON APP / MILANO 12 / PER BRESCIA / ETA ORE 13.40 / ORDER ... / SHIPMENT ..."; en Roma, "ROMA 2" y
//    "ASSEGNATO ROMA 4" dicen el numero de Roma; los "@nombre" no se leen: el chofer lo decide la oficina).
// Devuelve solo lo que encontro (null en lo demas) y una lista de avisos para quien revisa. No decide nada: lo demas lo completa la persona.

// Marcas invisibles que traen los textos copiados (guion blando, ancho cero, aislantes de direccion, BOM) y espacios raros.
const INVISIBLES = new RegExp("[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]", "g");

export const cleanText = (text) =>
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    // El portal pone un guion blando donde va un guion ("Cagnes-Sur-Mer"): entre dos letras es un guion de verdad; en fechas y codigos se borra.
    .replace(/(\p{L})\u00AD(\p{L})/gu, "$1-$2")
    .replace(INVISIBLES, "")
    .replace(new RegExp("[\u00A0\u2007\u202F]", "g"), " ")
    .trim();

// Etiquetas del portal: sirven para saber donde termina un valor de varias palabras (ej. el cliente).
const LABELS =
  "Shipment|From Warehouse|Warehouse|ETA|Mobile Phone|Ship To|Shipment lines|Part ID|Orders?|Service Type|Service Level|Reference|Customer|Bin Loc|Line Qty|Suggest LPN|Volume|Weight|Contatto";
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

// "ROMA VIA FOSSO DEL CAVALIERE" -> ciudad "Roma" (la calle no es parte de la ciudad: queda en la descripcion con el texto completo).
const CALLE = /\s+(?:via|viale|v\.le|piazza|p\.zza|piazzale|corso|largo|strada|vicolo|lungotevere|lungomare|localita|loc\.)\s+.+$/i;

const cityName = (raw) => {
  const clean = raw.replace(/[*_]/g, "").replace(CALLE, "").trim();
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
  m = /\bETA\s*[:=]?\s*(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2})[:.](\d{2})/i.exec(flat);
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

// Km del mensaje interno: "KM 124", "Km 35", "54 km", "141 KM". El texto del portal no los trae.
const findKm = (lines) => {
  const m = /(?:^|\n)\s*km\.?\s*[:=]?\s*(\d{1,4}(?:[.,]\d+)?)\b/i.exec(lines) ?? /(?:^|\n)\s*(\d{1,4}(?:[.,]\d+)?)\s*km\b/i.exec(lines);
  return m ? Number(m[1].replace(",", ".")) : null;
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
    // "PRE 4 HR", "PRE 3:45 HR SLA": servicio con un plazo de horas para retirar y entregar, o sea urgente (en los mensajes sale como "Nuovo servizio ASAP").
    if (/^pre\s*\d/i.test(value)) return "ASAP";
    avisos.push(`Service Level "${value}": non è né ASAP né SCHEDULED, il tipo resta da completare.`);
  }
  // Sin Service Level (o con uno que no es ASAP / SCHEDULED): la palabra suelta en el texto ("consegni asap", "servizio schedulato").
  const word = /\b(ASAP|SCHEDULAT[OA]|SCHEDULED?)\b/i.exec(flat);
  if (word) return /^asap$/i.test(word[1]) ? "ASAP" : "SCHEDULED";
  return null;
};

const TIPO_WORD = "(?:ASAP|SCHEDULAT[OA]|SCHEDULED?)";
// Lineas que son otro dato del mensaje (no el cliente ni la ciudad): "PER ...", ETA, KM, RITIRO, ORDER, SHIPMENT, "A CHI ASSEGNO?", "3 PARTI",
// la zona ("MILANO", "MILANO 12", "ROMA") o cualquier linea que empiece con un numero.
const ES_OTRO_DATO_MENSAJE = /^(?:eta\b|km\b|order\b|shipment\b|a chi\b|chi\b|@)/i;
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

// Numero de la zona del mensaje interno: una linea "ROMA 2" / "MILANO 12" o "ASSEGNATO ROMA 4". Solo el de la zona del servicio (Roma 1..10, Milano 1..18).
const ZONA_NUMEROS = { DHL_ROMA: { zona: "ROMA", max: 10 }, DHL_MILANO: { zona: "MILANO", max: 18 } };
const findAplicativo = (lines, servicio) => {
  const cfg = ZONA_NUMEROS[servicio];
  if (!cfg) return null;
  const m = new RegExp(`(?:^|\\n)\\s*(?:(?:e\\s+)?assegnato\\s+(?:a\\s+)?)?${cfg.zona}\\s+(\\d{1,2})\\s*(?=\\n|$)`, "i").exec(lines);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= cfg.max ? `${cfg.zona}_${n}` : null;
};

// --- AB Service: lugares del mensaje ---
// Un mensaje de AB Service nombra donde se retira y donde se entrega ("Ritiro: Via ... / Consegna: Via ... 20100 Milano"). Se leen las lineas con
// etiqueta (la direccion puede seguir en las lineas de abajo) y despues el servidor las localiza (Google, con cache) para confirmar que existen.
const ETIQUETA_RITIRO = /^(?:ritiro(?:\s+presso)?|ritirare|prelievo|pick\s*-?\s*up|partenza|origine|da)\s*[:\-–]\s*(.*)$/i;
const ETIQUETA_CONSEGNA = /^(?:consegna(?:\s+presso)?|consegnare|delivery|destinazione|arrivo|a)\s*[:\-–]\s*(.*)$/i;
const OTRA_ETIQUETA = /^(?:ritiro|ritirare|prelievo|pick|partenza|origine|da|consegna|consegnare|delivery|destinazione|arrivo|a|eta|km|totale|order|ordine|shipment|aut|note|a chi|chi)\s*[:\-–]/i;

// El deposito de AB Service (Romanengo): de ahi salen todos sus servicios. Va ya localizado (sus coordenadas estan en constants/salidaPorDefecto.js).
const LUGAR_AB = { rol: "ritiro", texto: "AB Service (magazzino di Romanengo)", fijo: true };

// "Ship To Address" (calle, puede venir en dos lineas) y "Ship To Postal Code" (CAP) del texto del portal. null si no estan.
const findCalle = (flat) => new RegExp(`\\bShip To Address\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat)?.[1]?.trim() || null;
const findCap = (flat) => new RegExp(`\\bShip To Postal Code\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat)?.[1]?.trim() || null;

// Texto del portal: la direccion de entrega son "Ship To Address", "Ship To Postal Code", "Ship To City" y la provincia (que el portal pone en "Ship To Country").
const lugarDeEntregaPortal = (flat, ciudad) => {
  const direccion = new RegExp(`\\bShip To Address\\s*[:=]?\\s*(.+?)${NEXT_LABEL}`, "i").exec(flat)?.[1]?.trim();
  if (!direccion) return null;
  const cap = /\bShip To Postal Code\s*[:=]?\s*(\d{4,5})/i.exec(flat)?.[1];
  const provincia = /\bShip To Country(?:\s+Code)?\s*[:=]?\s*([A-Z]{2})\b/.exec(flat)?.[1];
  const lugar = [direccion, [cap, ciudad].filter(Boolean).join(" "), provincia].filter(Boolean).join(", ");
  return { rol: "consegna", texto: lugar };
};

const findLugares = (lines) => {
  const all = messageLines(lines);
  const lugares = [];
  for (let i = 0; i < all.length; i += 1) {
    const ritiro = ETIQUETA_RITIRO.exec(all[i]);
    const consegna = ritiro ? null : ETIQUETA_CONSEGNA.exec(all[i]);
    const m = ritiro ?? consegna;
    if (!m) continue;
    let texto = m[1].trim();
    // La direccion sigue abajo: si la etiqueta esta sola, hasta 3 lineas; si ya trae calle, solo la linea del CAP ("20100 Milano").
    let extra = 0;
    for (let j = i + 1; j < all.length && extra < 3; j += 1) {
      const next = all[j];
      if (OTRA_ETIQUETA.test(next) || ES_OTRO_DATO_MENSAJE.test(next)) break;
      if (texto && !/^\d{5}\b/.test(next)) break;
      texto = `${texto} ${next}`.trim();
      extra += 1;
      i = j;
    }
    if (texto) lugares.push({ rol: ritiro ? "ritiro" : "consegna", texto });
  }
  return lugares;
};

// Ciudad de una direccion: la que sigue al CAP ("20100 Milano"), o el ultimo tramo despues de una coma.
const ciudadDeLugar = (texto) => {
  const conCap = /\b\d{5}\s+([^,\n(]+)/.exec(texto);
  if (conCap) return cityName(conCap[1].trim());
  const partes = texto.split(",").map((p) => p.trim());
  const ultima = partes.at(-1);
  if (partes.length > 1 && ultima && !/\d/.test(ultima)) return cityName(ultima);
  return !/\d/.test(texto) && texto.split(/\s+/).length <= 3 ? cityName(texto) : null;
};

// --- Extra Piazza ---
// No tienen un formato fijo, asi que se buscan las piezas por separado:
//  - Codigo: "S20602391" (puede haber dos: "S20602375 / S20602381") o el del giro "26WCIMXP0134810", en las primeras lineas. Va a shipment / orderNumero.
//  - Dia y hora: "DOMANI ORE 9", "Date: 30th Oct - ... ORE 00.30", "LAINATE ORE 7.30 / domani 28 oct", "PER DOMANI 24/10". La hora es la de "ORE"; el dia,
//    una fecha escrita ("28 oct", "24/10"), "domani" (solo si va con la hora o al inicio de una linea: "Da consegnare domani" no cuenta) u hoy.
//  - Lugares: "ritiro: ...", "Luogo di ritiro: ...", "Ritiro" + direccion en las lineas de abajo, "CONSEGNA / COMSEGNA ...", "e portarli ...", o la linea
//    "Battaglino a Peschiera" que va antes de la consegna. En los giros de Lainate ("26WCIMXP...") el ritiro es el punto de salida y la entrega son las
//    varias paradas de la lista ("Giro (4 tappe)").
// No se lee ni el cliente, ni el tipo, ni el km (los pone una persona) ni el chofer.
const CODIGO_EXTRA = /\b(?:S\d{7,9}|\d{2}[A-Z]{3,}[A-Z0-9]*\d{4,})\b/g;
const ES_CODIGO = new RegExp(CODIGO_EXTRA.source);
const MES_EXTRA =
  "(?:gen(?:naio)?|feb(?:braio)?|mar(?:zo)?|apr(?:ile)?|mag(?:gio)?|may|giu(?:gno)?|jun(?:e)?|lug(?:lio)?|jul(?:y)?|ago(?:sto)?|aug(?:ust)?|set(?:tembre)?|sep(?:t(?:ember)?)?|ott(?:obre)?|oct(?:ober)?|nov(?:embre|ember)?|dic(?:embre)?|dec(?:ember)?)";
const MES_NUM = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, may: 5, giu: 6, jun: 6, lug: 7, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, ott: 10, oct: 10, nov: 11, dic: 12, dec: 12 };
const DIA_PALABRA = "(?:lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|domani|oggi)";
const LINEA_DE_LISTA = /^\d{9}/;
const CARGA = /^\d+\s*(?:x\s*)?(?:colli|collo|pallet|bancal\w*|casse?|box(?:es)?|valigie|kg|kgs)\b|\b(?:pallet|colli|kgs?|cms?)\b/i;
const ES_ETIQUETA_EXTRA = /^(?:(?:luogo\s+di\s+)?ritiro|co[mn]segn[ae]|consegnare|da\s+consegnare|(?:e\s+)?portarli|date\s*:|eta\b|km\b)/i;
const ES_RUIDO_EXTRA = /^(?:nuovo\s+servizio|(?:loading|delivery|unloading)\s+address\s*:?|door|con\s+\w+|com\s+\w+|cassonato|[A-Z]{2}\d{3}[A-Z]{2})$/i;

const sinAcento = (t) => t.normalize("NFD").replace(/\p{M}/gu, "");

const findCodigosExtra = (all) => {
  const found = [];
  for (const l of all.slice(0, 5)) for (const m of l.matchAll(CODIGO_EXTRA)) if (!found.includes(m[0])) found.push(m[0]);
  return found;
};

// Fecha y hora de un Extra Piazza (ver arriba). Solo se mira el texto de antes de la lista de paradas, para no tomar las fechas de la tabla.
const findEtaExtra = (lines, now, avisos) => {
  const todos = lines.split("\n");
  const corte = todos.findIndex((l) => LINEA_DE_LISTA.test(l.trim()));
  const texto = (corte >= 0 ? todos.slice(0, corte) : todos).join("\n");
  const hora = /\bORE\s*(\d{1,2})(?:\s*[.:]\s*(\d{2}))?(?!\d)/i.exec(texto);
  if (!hora || +hora[1] > 23) return null;

  const [ty, tm, td] = romeDay(now).split("-").map(Number);
  const candidatos = [];
  for (const m of texto.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/g)) {
    if (+m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) candidatos.push({ i: m.index, d: +m[1], mo: +m[2] });
  }
  for (const m of sinAcento(texto).matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|°)?\\s+(?:di\\s+)?(${MES_EXTRA})\\b`, "gi"))) {
    if (+m[1] >= 1 && +m[1] <= 31) candidatos.push({ i: m.index, d: +m[1], mo: MES_NUM[m[2].toLowerCase().slice(0, 3)] });
  }
  candidatos.sort((a, b) => a.i - b.i);

  let day;
  if (candidatos.length) {
    const { d, mo } = candidatos[0];
    let year = ty;
    // Una fecha que ya paso hace mas de medio año es del año que viene (un mensaje de diciembre que habla de enero).
    if (Date.UTC(year, mo - 1, d) < Date.UTC(ty, tm - 1, td) - 180 * 86400000) year += 1;
    day = `${year}-${pad(mo)}-${pad(d)}`;
  } else if (new RegExp(`(?:^|\\n)\\s*(?:per\\s+)?domani\\b|\\bdomani\\s+ore\\b`, "i").test(texto)) {
    day = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
  } else {
    day = romeDay(now);
    avisos.push("L'ETA contiene solo l'ora: si è supposto oggi.");
  }
  return romeLocalToDate(day, `${pad(+hora[1])}:${hora[2] ?? "00"}`);
};

// Valor de un lugar: sin la hora ("ORE 18"), las palabras de dia ("lunedi", "domani") ni el "per".
const limpiarLugar = (v) =>
  sinAcento(v ?? "") === ""
    ? ""
    : v
        .replace(/\bORE\s*\d{1,2}(?:\s*[.:]\s*\d{2})?/gi, " ")
        .replace(new RegExp(`\\b${DIA_PALABRA}\\b`, "gi"), " ")
        .replace(/(?<!\d)\d{1,2}\/\d{1,2}(?!\d)/g, " ")
        .replace(new RegExp(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?\\s+${MES_EXTRA}\\b`, "gi"), " ")
        .replace(/^\s*(?:per|presso)\b/i, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s:.\-–]+|[\s:\-–]+$/g, "");

// El valor que sigue a una etiqueta; si esta vacio o es corto, las lineas de abajo que siguen siendo del lugar (direccion partida en varias lineas).
const lugarDesdeEtiqueta = (all, i, valor, { max }) => {
  const partes = [];
  const primero = limpiarLugar(valor);
  if (primero && !CARGA.test(primero)) partes.push(primero);
  else if (primero) return null;
  for (let j = i + 1; j < all.length && partes.length < max; j += 1) {
    const l = all[j];
    if (ES_ETIQUETA_EXTRA.test(l) || (ES_RUIDO_EXTRA.test(l) && !/^(?:loading|delivery|unloading)/i.test(l))) break;
    if (/^(?:loading|delivery|unloading)\s+address\s*:?$/i.test(l)) continue;
    if (LINEA_DE_LISTA.test(l) || (/^\d/.test(l) && !/^\d{5}\b/.test(l)) || /^ore\b/i.test(l) || CARGA.test(l) || l.split(" ").length > 8) break;
    const limpia = limpiarLugar(l);
    if (!limpia) break;
    partes.push(limpia);
    // Con un valor ya en la propia linea, solo se acepta una linea mas (el nombre de la ciudad).
    if (primero) break;
  }
  return partes.length ? partes.join(", ") : null;
};

const findLugaresExtra = (all, giro) => {
  let ritiro = null;
  let consegna = null;
  let iConsegna = -1;
  for (let i = 0; i < all.length; i += 1) {
    const l = all[i];
    if (giro) break;
    if (!ritiro) {
      const m = /^(?:luogo\s+di\s+)?ritiro\b[\s:.\-–]*(.*)$/i.exec(l);
      if (m) {
        ritiro = lugarDesdeEtiqueta(all, i, m[1], { max: 4 });
        continue;
      }
    }
    if (!consegna) {
      const m = /^(?:co[mn]segn[ae]|consegnare|da\s+consegnare|(?:e\s+)?portarli(?:\s+(?:a|al|in))?(?:\s+magazzino)?)\b[\s:.\-–]*(.*)$/i.exec(l);
      if (m) {
        consegna = lugarDesdeEtiqueta(all, i, m[1], { max: 2 });
        iConsegna = i;
      }
    }
  }
  // "Battaglino a Peschiera": sin etiqueta de ritiro, la linea de lugar que va justo antes de la consegna.
  if (!giro && !ritiro && iConsegna > 0) {
    for (let j = iConsegna - 1; j >= 0; j -= 1) {
      const l = all[j];
      const limpia = limpiarLugar(l);
      if (!limpia || ES_RUIDO_EXTRA.test(l) || ES_ETIQUETA_EXTRA.test(l) || ES_CODIGO.test(l) || CARGA.test(l) || /^\d/.test(l) || limpia.split(" ").length > 6) continue;
      ritiro = limpia;
      break;
    }
  }
  return { ritiro, consegna };
};

// Giro (26WCIMXP...): el punto de salida es la primera linea con un lugar (sin la hora ni el dia), y las paradas son las lineas de la lista.
const findSalidaGiro = (all) => {
  for (const l of all) {
    if (LINEA_DE_LISTA.test(l)) break;
    if (ES_CODIGO.test(l) || ES_RUIDO_EXTRA.test(l)) continue;
    const limpia = limpiarLugar(l);
    if (limpia && /\p{L}{3}/u.test(limpia) && limpia.split(" ").length <= 8) return limpia;
  }
  return null;
};

const parseExtraPiazza = (lines, now) => {
  const avisos = [];
  const all = messageLines(lines);
  const codigos = findCodigosExtra(all);
  const giro = /^\d{2}[A-Z]{3,}/.test(codigos[0] ?? "");
  let ritiro;
  let consegna;
  if (giro) {
    ritiro = findSalidaGiro(all);
    const tappe = all.filter((l) => LINEA_DE_LISTA.test(l)).length;
    consegna = tappe ? `Giro (${tappe} tappe)` : null;
  } else {
    ({ ritiro, consegna } = findLugaresExtra(all, false));
  }
  const eta = findEtaExtra(lines, now, avisos);

  if (!codigos.length) avisos.push("Codice non trovato.");
  if (!ritiro) avisos.push('Luogo di ritiro non trovato (scrivilo come "Ritiro: via ... città").');
  if (!consegna) avisos.push('Luogo di consegna non trovato (scrivilo come "Consegna: via ... città").');
  if (!eta) avisos.push("ETA non trovata.");

  const lugares = [ritiro && { rol: "ritiro", texto: ritiro }, consegna && !giro && { rol: "consegna", texto: consegna }].filter(Boolean);
  return {
    descripcion: lines,
    shipment: codigos[0] ?? null,
    orderNumero: codigos.length > 1 ? codigos.slice(1).join(" ") : null,
    cliente: null,
    clienteId: null,
    tipoPedido: null,
    tipoOrigen: null,
    ciudad: consegna,
    ritiro,
    eta,
    km: null,
    aplicativo: null,
    lugares,
    avisos,
  };
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
export const parseServicioTexto = (text, { clients = [], now = new Date(), servicio = "DHL_MILANO" } = {}) => {
  const avisos = [];
  const lines = cleanText(text);
  if (servicio === "EXTRA_PIAZZA") return parseExtraPiazza(lines, now);
  const flat = ` ${lines.replace(/\s+/g, " ")} `;

  const shipment = /\bShipment\s*#?\s*[:.]?\s*(\d{6,})/i.exec(flat)?.[1] ?? null;
  const orderNumero = /\bOrder\s*#?\s*[:.]?\s*(\d{6,})/i.exec(flat)?.[1] ?? null;
  const esAb = servicio === "AB_SERVICE";
  // AB Service es siempre del cliente AB: si el texto no dice otro, se da por AB.
  const clienteTexto = findCliente(flat, lines) ?? (esAb ? "AB" : null);
  const client = matchClient(clienteTexto, clients);
  const tipoPedido = findTipo(flat, avisos);
  const ciudadTexto = findCity(flat, lines);
  const calle = findCalle(flat);
  const cap = findCap(flat);
  // AB Service: la recogida es el deposito de AB; la entrega, la direccion del texto (portal) o la linea "Consegna: ...".
  const portal = esAb ? lugarDeEntregaPortal(flat, ciudadTexto) : null;
  const etiquetados = esAb && !portal ? findLugares(lines) : [];
  const lugares = esAb ? [LUGAR_AB, ...(portal ? [portal] : etiquetados.filter((l) => l.rol === "consegna"))] : [];
  const entrega = lugares.find((l) => l.rol === "consegna");
  const ciudad = ciudadTexto ?? (entrega ? ciudadDeLugar(entrega.texto) : null);
  const eta = findEta(flat, now, avisos);
  const km = findKm(lines);
  const aplicativo = findAplicativo(lines, servicio);

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
  if (esAb && !entrega) avisos.push("Luogo di consegna non trovato (scrivilo come \"Consegna: via ... CAP città\").");

  return {
    descripcion: lines,
    shipment,
    orderNumero,
    cliente: client?.nombre ?? clienteTexto,
    clienteId: client?.id ?? null,
    tipoPedido: tipo,
    tipoOrigen,
    ciudad,
    calle,
    cap,
    eta,
    km,
    aplicativo,
    lugares,
    avisos,
  };
};
