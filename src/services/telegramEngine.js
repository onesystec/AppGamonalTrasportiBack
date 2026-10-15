import { randomUUID } from "node:crypto";
import { defaultSalidaFor } from "../constants/salidaPorDefecto.js";
import { romeDay, romeHHMM, romeLocalToDate } from "../utils/romeTime.js";

// Motor del bot de Telegram: entiende el mensaje con reglas fijas (sin IA) y lleva la conversacion paso a paso.
// No toca la base ni la red: recibe las listas de choferes/vehiculos/clientes y devuelve el estado nuevo y lo que hay que
// contestar. La IA (ctx.aiExtract) solo se llama cuando quedo texto que las reglas no pudieron ubicar.

// Cada comando elige el formulario. kmCliente: DHL y AB Service -> los km los da el cliente (solo ida, el app los x2);
// en Extras y Otros el app calcula el circuito completo.
export const TIPOS = {
  DM: { code: "DM", label: "DHL Milano", spedizzione: "DHL", zona: "MILANO", kmCliente: true, aplicativo: true },
  DR: { code: "DR", label: "DHL Roma", spedizzione: "DHL", zona: "ROMA", kmCliente: true, aplicativo: true },
  PM: { code: "PM", label: "Extras Piazza Milano", spedizzione: "EXTRA_PIAZZA", zona: "MILANO" },
  PR: { code: "PR", label: "Extras Piazza Roma", spedizzione: "EXTRA_PIAZZA", zona: "ROMA" },
  AB: { code: "AB", label: "AB Service", spedizzione: "AB_SERVICE", zona: "MILANO", zonaVariable: true, kmCliente: true },
  O: { code: "O", label: "Otros (Extras Stefania)", spedizzione: "EXTRAS_STEFANIA", zona: null },
};

const APLICATIVO_MAX = { MILANO: 18, ROMA: 10 };

export const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const lev = (a, b) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
};

// Mismo token, o con 1 letra de diferencia si es una palabra larga (los nombres cortos no se tocan: se confundirian).
export const tokenClose = (t, name) => t === name || (!/\d/.test(t) && t.length >= 6 && name.length >= 6 && lev(t, name) <= 1);

const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (h, m) => `${pad2(Number(h))}:${pad2(Number(m ?? 0))}`;
const toNumber = (v) => Number(String(v).replace(",", "."));

// Extras Piazza (PM/PR): la hora del mensaje es la hora de RETIRO. La llegada al ultimo punto se calcula con la ruta.
export const isExtrasPiazza = (state) => state.tipo === "PM" || state.tipo === "PR";

// El retiro esta listo cuando se confirmo (o, en un lote, cuando el mensaje traia la hora).
const retiroReady = (state) => Boolean(state.retiroOk || (state.autoRetiro && state.horaSalida));
// El dia del servicio se pregunta siempre (de ahi sale la distribucion por dias); vale tambien si el mensaje lo traia ("domani", "18/10")
// y en un lote, donde la fecha por defecto es hoy.
const fechaReady = (state) => Boolean(state.fechaOk || (state.autoRetiro && state.fecha));
// Extras Piazza: la llegada calculada con la ruta se confirma (o se corrige) antes de cargar.
const etaConfirmed = (state) => Boolean(state.etaOk || state.etaManual || state.autoRetiro);

export const parseCommand = (text, { strict = false } = {}) => {
  const m = /^\s*(\/)?(dm|dr|pm|pr|ab|o)(?:@\w+)?(?=$|[\s,:;.\-–])/i.exec(text);
  if (!m) return null;
  // "O" suelta es una palabra comun: solo cuenta en mayuscula o con barra (y en lineas de un lote, solo con barra).
  if (m[2].toLowerCase() === "o" && !m[1] && (m[2] !== "O" || strict)) return null;
  return { tipo: TIPOS[m[2].toUpperCase()], rest: text.slice(m[0].length) };
};

// ---------------------------------------------------------------------------------------------------------------------
// Extraccion de campos de un texto
// ---------------------------------------------------------------------------------------------------------------------

const take = (text, regex) => {
  const m = regex.exec(text);
  if (!m) return { text, match: null };
  return { text: `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`, match: m };
};

const SEPARATORS = /\s*(?:->|→|>|–|—|\s-\s|,|;|\n|\|)\s*/;
const LEADING_FILLER = /^(?:(?:chofer|autista|conductor|driver|cliente|targa|vehiculo|vehículo)\s*[:=]?\s+|(?:a|al|para|hasta|hacia|verso|per)\s+)/i;
const DEPOT_WORDS = new Set(["peschiera borromeo", "peschiera", "base", "deposito", "depósito", "dhl milano", "dhl roma", "ab service"]);

// Chofer / cliente nombrados dentro de un texto. Recorre las palabras y devuelve cuales se usaron para sacarlas del texto.
const findPerson = (words, people, { preferEarliest = false } = {}) => {
  const wn = words.map((w) => norm(w));
  let best = [];
  let bestScore = 0;
  for (const p of people) {
    const used = new Set();
    for (const nt of new Set(p.tokens.filter((t) => t.length >= 3))) {
      const idx = wn.findIndex((w, i) => !used.has(i) && w && tokenClose(w, nt));
      if (idx >= 0) used.add(idx);
    }
    if (used.size === 0) continue;
    // Mas palabras coincidentes gana; a igual cantidad, el nombre mas "completo" (DHL antes que DHL Roma).
    const score = used.size + used.size / p.tokens.length / 10;
    if (score > bestScore) {
      bestScore = score;
      best = [{ p, used }];
    } else if (score === bestScore) best.push({ p, used });
  }
  if (best.length === 0) return null;
  if (best.length > 1 && preferEarliest) {
    best.sort((a, b) => Math.min(...a.used) - Math.min(...b.used));
    if (Math.min(...best[0].used) < Math.min(...best[1].used)) best = [best[0]];
  }
  if (best.length > 1) return { ambiguous: best.map((b) => b.p.id), used: best[0].used };
  return { id: best[0].p.id, used: best[0].used };
};

const personList = (items, nameOf) => items.map((it) => ({ id: it.id, tokens: norm(nameOf(it)).split(" ").filter(Boolean) }));

// Codigo propio de los servicios Extras Piazza: llega escrito en el mensaje, casi siempre en la primera linea.
//   26WCIMXP0129810 · S20602155 · AP1011-480 (y variantes con sufijo cuando el mismo codigo se repite: ...-B, ...-C)
const SERVICE_CODE = /\b(\d{2}[A-Z]{3,8}\d{6,9}|S\d{8}|AP\d{3,5}-\d{2,4})(-[A-Z])?\b/i;
export const findServiceCode = (text) => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const chunk of [lines.slice(0, 2).join("\n"), text]) {
    const m = SERVICE_CODE.exec(chunk);
    if (m) return `${m[1]}${m[2] ?? ""}`.toUpperCase();
  }
  return null;
};

// Cliente segun el formato del codigo (98% de los casos): "26WCIMXP0129810" (año + letras + numero) es World Courier y
// "S20602155" (S + 8 digitos) es Extras Piazza. Con otros formatos (AP1011-480...) no se decide.
const clientNameForCode = (code) => (/^\d{2}[A-Z]{3,8}\d{6,9}/.test(code) ? "world courier" : /^S\d{8}/.test(code) ? "extra piazza" : null);

// Ruta de un mensaje de Extras Piazza leyendo sus palabras clave, sin IA:
//   REC = recuperar/retirar en ese lugar · DLV / DELIVERY / CONSEGNA = entregar en ese lugar (el nombre que sigue es una ubicacion)
//   "REC A MXP E DLV  BIOREP" -> Malpensa, BIOREP        "CONSEGNA  PALAZZO PIGNANO(CREMONA)" -> Palazzo Pignano (Cremona)
//   "Ritiro documenti" (el lugar es la linea anterior) y el bloque despues de "Consegna:" (direccion en varias lineas).
// Tambien la direccion que acompaña a "ORE 7.00" en la primera linea (donde se hace el retiro). Las siglas de aeropuerto se escriben completas.
const AIRPORTS = {
  MXP: "Aeroporto di Malpensa",
  LIN: "Aeroporto di Linate",
  BGY: "Aeroporto di Bergamo Orio al Serio",
  FCO: "Aeroporto di Fiumicino",
  CIA: "Aeroporto di Ciampino",
  VRN: "Aeroporto di Verona",
  VCE: "Aeroporto di Venezia",
  BLQ: "Aeroporto di Bologna",
  TRN: "Aeroporto di Torino",
  GOA: "Aeroporto di Genova",
};
const cleanPlace = (raw) => {
  const t = raw.replace(/["“”*]/g, "").replace(/\(([^)]+)\)/g, ", $1").replace(/\s+/g, " ").replace(/^[\s.,:;-]+|[\s.,:;-]+$/g, "");
  return AIRPORTS[t.toUpperCase()] ?? t;
};
const PLACE_STOP = String.raw`(?=\s{2,}|\t|\s+(?:arriva|recuperare|recupero|distinta|polizza|ice)\b|\s+\d{1,2}(?:[.:]\d{2})?\s*$|$)`;
const DAY_WORDS = /\b(?:domani|oggi|hoy|ma[ñn]ana|pasado)\b/gi;

export const parseExtrasRoute = (text) => {
  const lines = text.split("\n");
  const found = [];
  let hasDelivery = false;
  let seenPickup = false;
  lines.forEach((line, i) => {
    // Direccion de retiro junto a la hora ("LAINATE VIA VARESE 38 ORE 7.00").
    const ore = /^(.*?)\s*\bORE\s+\d{1,2}[.:h]?\d{0,2}/i.exec(line);
    if (ore && !seenPickup) {
      const before = cleanPlace(ore[1].replace(DAY_WORDS, " "));
      if (/[A-Za-zÀ-ÿ]{3}/.test(before) && before.split(" ").length <= 8) {
        found.push({ pos: i, place: before });
        seenPickup = true;
      }
    }
    const rec = /\bREC(?:UPERO|\.)?\s+(?:A\s+|AL\s+|DA\s+)?(.{1,40}?)(?=\s*\+|\s{2,}|\s+E\s+(?:DLV|[Dd][Ee][Ll][Ii][Vv])|\s+(?:DLV|[Dd][Ee][Ll][Ii][Vv])|$)/.exec(line);
    const dlv = new RegExp(String.raw`\b(?:DLV|DELIVERY|DELIV|CONSEGNA|CONS)\b\.?:?\s*(.+?)${PLACE_STOP}`, "i").exec(line);
    if (rec && !/^\d+$/.test(rec[1].trim())) found.push({ pos: i + 0.1, place: cleanPlace(rec[1]) });
    if (dlv && dlv[1].trim() && !/^\d+$/.test(dlv[1].trim()) && !/^:?$/.test(dlv[1].trim())) {
      found.push({ pos: i + 0.2, place: cleanPlace(dlv[1]) });
      hasDelivery = true;
    }
  });
  // Estilo "Ritiro ..." / "Consegna:" en lineas separadas.
  const ritiro = lines.findIndex((l) => /^\s*ritiro\b/i.test(l));
  if (ritiro > 0) {
    for (let j = ritiro - 1; j >= 0; j -= 1) {
      const l = lines[j].trim();
      if (!l) continue;
      if (!/^(nuovo servizio|servizio|domani|oggi|hoy|ma[ñn]ana|ore\b)/i.test(l) && !/\d{1,2}[.:]\d{2}/.test(l)) found.push({ pos: j, place: cleanPlace(l) });
      break;
    }
  }
  const cons = lines.findIndex((l) => /^\s*consegna\s*:?\s*$/i.test(l));
  if (cons >= 0) {
    const addr = lines.slice(cons + 1).map((l) => l.trim()).filter(Boolean).filter((l) => !/^(tel|note?|ritiro)\b/i.test(l));
    if (addr.length) {
      found.push({ pos: cons + 0.5, place: cleanPlace(addr.slice(0, 4).join(", ")) });
      hasDelivery = true;
    }
  }
  if (!hasDelivery) return [];
  const stops = [];
  for (const { place } of found.sort((a, b) => a.pos - b.pos)) if (place && place !== stops.at(-1)) stops.push(place);
  return stops;
};

// found: lo que se entendio de ESTE texto (solo claves presentes). leftover: pedazos largos que no se pudieron ubicar.
export const extractFields = (input, ctx, { tipo, onlyDrivers, allowDriver = false } = {}) => {
  const found = {};
  const leftover = [];
  // Las menciones (@Romario) y el "GT" (Gamonal Trasporti) que se agrega a los nombres no son datos.
  let text = ` ${input.replace(/@/g, " ").replace(/\bGT\b/gi, " ")} `;
  const today = ctx.today;
  let m;

  // Codigo escrito a mano ("codigo: ABC-1") en cualquier tipo; en Extras Piazza ademas se busca solo.
  ({ text, match: m } = take(text, /\bc[oó]d(?:igo)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{3,30})/i));
  if (m) found.codigo = m[1].toUpperCase();
  else if (tipo === "PM" || tipo === "PR") {
    const code = findServiceCode(text);
    if (code) {
      found.codigo = code;
      const at = text.toUpperCase().indexOf(code);
      text = `${text.slice(0, at)} ${text.slice(at + code.length)}`;
    }
  }

  let routeParsed = [];
  let clientFromCode = false;
  if ((tipo === "PM" || tipo === "PR") && found.codigo) {
    const wanted = clientNameForCode(found.codigo);
    const c = wanted && ctx.refs.clients.find((x) => norm(x.nombre) === wanted);
    if (c) {
      found.clientId = c.id;
      found.clientFromCode = true;
      clientFromCode = true;
    }
  }
  if (tipo === "PM" || tipo === "PR") routeParsed = parseExtrasRoute(input);

  ({ text, match: m } = take(text, /\b(?:desc(?:ripcion|ripción)?|nota)\s*[:=]\s*([^\n]+)/i));
  if (m) found.descripcion = m[1].trim();

  ({ text, match: m } = take(text, /\b(?:ruta|destinos?|recorrido|itinerario)\s*[:=]\s*([^\n;]+)/i));
  const routeText = m ? m[1] : null;

  // Numeros de pedido del cliente: se guardan en la descripcion.
  const refsFound = [];
  for (;;) {
    ({ text, match: m } = take(text, /\b(order|ordine|shipment)\s*[:=#]?\s*(\d{5,})\b/i));
    if (!m) break;
    refsFound.push(`${m[1].toLowerCase() === "shipment" ? "Shipment" : "Order"} ${m[2]}`);
  }
  if (refsFound.length) found.refs = refsFound;

  // "KM 89" gana sobre "13.14 KM" (una hora pegada a la palabra km).
  ({ text, match: m } = take(text, /\bkm\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i));
  if (m) found.km = toNumber(m[1]);
  else {
    ({ text, match: m } = take(text, /(\d+(?:[.,]\d+)?)\s*km\b/i));
    if (m) found.km = toNumber(m[1]);
  }

  ({ text, match: m } = take(text, /\b(?:aplicativo|aplic|apl|app)\.?\s*(?:milano|roma)?\s*[:=#]?\s*(\d{1,2})\b/i));
  if (m) found.aplicativoN = Number(m[1]);

  ({ text, match: m } = take(text, /\b([A-Z]{2})\s?(\d{3})\s?([A-Z]{2})\b/i));
  if (m) found.targa = `${m[1]}${m[2]}${m[3]}`.toUpperCase();

  ({ text, match: m } = take(text, /\bpasado\s+ma[ñn]ana\b|\bdopodomani\b/i));
  if (m) found.fecha = addDays(today, 2);
  else {
    ({ text, match: m } = take(text, /\b(?:ayer|ieri)\b/i));
    if (m) found.fecha = addDays(today, -1);
  }
  if (!found.fecha) {
    ({ text, match: m } = take(text, /\b(?:ma[ñn]ana|domani)\b/i));
    if (m) found.fecha = addDays(today, 1);
    else {
      ({ text, match: m } = take(text, /\b(?:hoy|oggi)\b/i));
      if (m) found.fecha = today;
    }
  }
  if (!found.fecha) {
    ({ text, match: m } = take(text, /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/));
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
      if (year < 100) year += 2000;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) found.fecha = `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }

  ({ text, match: m } = take(text, /\b(?:sale|salida|retiro|ritiro|parte|partenza)\s*(?:a\s+las?|alle|ore|hora|:)?\s*(\d{1,2})(?:[:.h]([0-5]\d))?\b/i));
  if (m && Number(m[1]) <= 23) found.horaSalida = hhmm(m[1], m[2]);
  ({ text, match: m } = take(text, /\b(?:eta|llegada|llega|entrega|consegna)\s*(?:a\s+las?|alle|ore|hora|orario|:)?\s*(\d{1,2})(?:[:.h]([0-5]\d))?\b/i));
  if (m && Number(m[1]) <= 23) found.hora = hhmm(m[1], m[2]);
  const free = [];
  for (;;) {
    ({ text, match: m } = take(text, /\b(?:ore\s+)?([01]?\d|2[0-3])[:.h]([0-5]\d)\b/i));
    if (!m) break;
    free.push(hhmm(m[1], m[2]));
  }
  if (tipo === "PM" || tipo === "PR") {
    // Las demas horas del texto ("arriva a lin alle 9.10") son notas del recorrido, no datos del servicio.
    if (!found.horaSalida && free.length) found.horaSalida = free[0];
  } else if (free.length === 1) {
    if (!found.hora) found.hora = free[0];
    else if (!found.horaSalida) found.horaSalida = free[0];
  } else if (free.length >= 2) {
    if (!found.horaSalida) found.horaSalida = free[0];
    if (!found.hora) found.hora = free[free.length - 1];
  }

  // El chofer NUNCA se adivina del mensaje (los nombres con que abre son de la oficina): solo vale si se escribe "chofer X" o si es
  // la respuesta a la pregunta del bot (allowDriver).
  let labeledDriver = null;
  if (!allowDriver) {
    ({ text, match: m } = take(text, /\b(?:chofer|autista|conductor|driver)\s*[:=]?\s+([\p{L}'’]+(?:\s+[\p{L}'’]+)?)/iu));
    if (m) labeledDriver = m[1].split(/\s+/);
  }

  // Palabras sueltas: cliente se busca por nombre; lo que sobra son ciudades.
  text = text.replace(/\b(?:chofer|autista|conductor|driver|cliente|targa|vehiculo|vehículo)\b\s*[:=]?/gi, " ");
  let pieces = text.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  const words = pieces.flatMap((p, pi) => p.split(/\s+/).map((w) => ({ w, pi })));
  const drivers = onlyDrivers ? ctx.refs.drivers.filter((d) => onlyDrivers.includes(d.id)) : ctx.refs.drivers;
  const usedWords = new Set();

  const client = clientFromCode
    ? null
    : findPerson(
        words.map((x) => x.w),
        personList(ctx.refs.clients, (c) => c.nombre),
        { preferEarliest: true }
      );
  if (client?.ambiguous) found.clientAmbiguous = true;
  else if (client) {
    found.clientId = client.id;
    for (const k of client.used) usedWords.add(k);
  }

  const driverWords = allowDriver
    ? words.map((x, i) => ({ w: x.w, i })).filter(({ i }) => !usedWords.has(i))
    : labeledDriver?.map((w) => ({ w, i: null }));
  if (driverWords?.length) {
    const r = findPerson(
      driverWords.map((x) => x.w),
      personList(drivers, (d) => `${d.nombre} ${d.apellido}`)
    );
    if (r) {
      if (r.ambiguous) found.driverCandidates = r.ambiguous;
      else found.driverId = r.id;
      for (const k of r.used) if (driverWords[k].i != null) usedWords.add(driverWords[k].i);
    }
  }

  const rebuilt = new Map();
  words.forEach((x, i) => {
    if (!usedWords.has(i)) rebuilt.set(x.pi, [...(rebuilt.get(x.pi) ?? []), x.w]);
  });
  pieces = [...rebuilt.values()].map((ws) => ws.join(" ").trim()).filter(Boolean);

  const stops = [];
  const addStop = (raw, force) => {
    let s = raw.replace(LEADING_FILLER, "").replace(/^[\s.:\-–]+|[\s.:\-–]+$/g, "").trim();
    if (s.length < 2 || s.includes("?")) return;
    if (DEPOT_WORDS.has(s.toLowerCase()) && stops.length === 0) return;
    if (!force && (s.split(/\s+/).length > 8 || s.length > 80)) {
      leftover.push(s);
      return;
    }
    stops.push(s);
  };
  if (routeText) routeText.split(SEPARATORS).forEach((p) => addStop(p, true));
  pieces.forEach((p) => addStop(p, false));
  if (routeParsed.length && !routeText) {
    // Ruta leida de las palabras clave: manda sobre las ciudades sueltas y ya no hace falta la IA.
    found.destinos = routeParsed;
    leftover.length = 0;
  } else if (stops.length) found.destinos = stops;
  return { found, leftover, routeLabeled: Boolean(routeText) || routeParsed.length > 0 };
};

// ---------------------------------------------------------------------------------------------------------------------
// Estado de la conversacion
// ---------------------------------------------------------------------------------------------------------------------

export const newState = (tipoCode) => ({ v: 2, tipo: tipoCode, stage: "collect", pending: null, destinos: [] });

export const zonaDe = (state) => {
  const tipo = TIPOS[state.tipo];
  if (tipo.zonaVariable) return (state.destinos ?? []).some((d) => /\b(roma|fiumicino|ciampino)\b/i.test(norm(d))) ? "ROMA" : "MILANO";
  return tipo.zona;
};

const salidaLabel = (state) => {
  const tipo = TIPOS[state.tipo];
  const s = defaultSalidaFor({ spedizzione: tipo.spedizzione, extrasPiazzaZona: zonaDe(state) ?? undefined });
  return s.direccion.startsWith("Via Walter Tobagi") ? "DHL Milano" : s.direccion;
};

// Aplica lo entendido de un texto al estado. Una mencion nueva pisa la anterior (asi se corrige escribiendo de nuevo).
const merge = (state, found, ctx) => {
  const next = { ...state };
  if (found.driverId && found.driverId !== next.driverId) {
    next.driverId = found.driverId;
    next.driverCandidates = null;
  }
  if (found.driverCandidates && !next.driverId) next.driverCandidates = found.driverCandidates;
  if (found.targa) {
    const v = ctx.refs.vehicles.find((x) => norm(x.targa).replace(/ /g, "") === found.targa.toLowerCase());
    if (v) {
      next.vehicleId = v.id;
      next.unknownTarga = null;
    } else next.unknownTarga = found.targa;
  }
  if (found.clientId) {
    next.clientId = found.clientId;
    next.clientAuto = false;
    next.clientFromCode = Boolean(found.clientFromCode);
  }
  if (found.hora && isExtrasPiazza(next)) next.etaManual = true;
  for (const key of ["fecha", "hora", "horaSalida", "km", "aplicativoN", "descripcion"]) if (found[key] != null) next[key] = found[key];
  if (found.destinos) next.destinos = found.destinos;
  if (found.refs) next.refs = found.refs;
  if (found.codigo) next.codigo = found.codigo;
  if (found.retiroOk) next.retiroOk = true;
  if (found.etaOk) next.etaOk = true;
  if (found.fecha) next.fechaOk = true;
  return next;
};

const defaultClientFor = (state, clients) => {
  const code = state.tipo;
  const wanted = code === "DM" || code === "DR" ? ["dhl"] : code === "AB" ? ["ab", "service"] : null;
  if (!wanted) return null;
  let list = clients.filter((c) => wanted.every((w) => norm(c.nombre).split(" ").includes(w)));
  if (list.length > 1 && (code === "DM" || code === "DR")) {
    const roma = list.filter((c) => norm(c.nombre).includes("roma"));
    list = code === "DR" ? (roma.length ? roma : list) : list.filter((c) => !norm(c.nombre).includes("roma"));
  }
  return list.length === 1 ? list[0].id : null;
};

const applyDefaults = async (state, ctx) => {
  const next = { ...state };
  if (!next.clientId) {
    const id = defaultClientFor(next, ctx.refs.clients);
    if (id) {
      next.clientId = id;
      next.clientAuto = true;
    }
  }
  if (!next.fecha && (next.hora || next.horaSalida)) next.fecha = ctx.today;
  return next;
};

// Campos obligatorios que faltan, en el orden en que se preguntan.
export const missingFields = (state) => {
  const tipo = TIPOS[state.tipo];
  const missing = [];
  if (!state.driverId) missing.push("driver");
  if (!state.vehicleId) missing.push("vehicle");
  // Justo despues del vehiculo: el dia, la hora de retiro (salida del vehiculo; con ella el servicio pasa solo a "En camino" a los
  // 15 minutos) y la ETA. En Extras Piazza la ETA sale de la ruta y se confirma al final.
  if (!fechaReady(state)) missing.push("fecha");
  if (!retiroReady(state)) missing.push("retiro");
  if (!isExtrasPiazza(state) && !state.hora) missing.push("eta");
  if (!state.clientId) missing.push("client");
  if (!state.destinos?.length) missing.push("destinos");
  if (tipo.kmCliente && !(state.km > 0)) missing.push("km");
  if (tipo.aplicativo && !state.aplicativoN) missing.push("aplicativo");
  if (!tipo.kmCliente && !state.descripcion) missing.push("descripcion");
  if (isExtrasPiazza(state) && retiroReady(state)) {
    if (state.etaFailed && !state.hora) missing.push("eta");
    else if (state.hora && !etaConfirmed(state)) missing.push("etaConfirm");
  }
  return missing;
};

const nameOf = (u) => `${u.nombre} ${u.apellido}`;

const QUESTIONS = {
  eta: "¿A qué hora es la ETA (llegada/entrega)? Ej: 14:30",
  destinos: "¿Cuál es la ruta? Ciudades en orden, ej: Lodi - Piacenza (la salida va sola, no hace falta ponerla).",
  descripcion: "¿Descripción del servicio?",
};

const question = (field, state, ctx) => {
  const tipo = TIPOS[state.tipo];
  switch (field) {
    case "driver":
      if (state.driverCandidates?.length) {
        const names = state.driverCandidates.map((id) => nameOf(ctx.refs.drivers.find((d) => d.id === id))).join(" / ");
        return `Hay más de un chofer que coincide: ${names}. ¿Cuál es? (escribe nombre y apellido)`;
      }
      return "¿Qué chofer hace el servicio?";
    case "vehicle":
      return state.unknownTarga
        ? `No encuentro la targa ${state.unknownTarga} entre los vehículos del bot (solo salen los disponibles; no están los de Farmacia, mantenimiento ni fuera de servicio). ¿Con qué vehículo? Toca uno o escribe la targa.`
        : "¿Con qué vehículo? Toca uno o escribe la targa.";
    case "client": {
      const names = ctx.refs.clients.map((c) => c.nombre);
      return names.length && names.length <= 12 ? `¿Para qué cliente? (${names.join(", ")})` : "¿Para qué cliente?";
    }
    case "fecha":
      return "¿Qué día es el servicio (el día del retiro)? Toca una opción o escribe la fecha (ej: 18/10).";
    case "etaConfirm":
      return `Llegada estimada al último punto: ${fmtFecha(state.etaFecha ?? state.fecha)} ${state.hora}${state.rutaMin ? ` (ruta ≈ ${state.rutaKm} km · ${Math.floor(state.rutaMin / 60)} h ${state.rutaMin % 60} min de manejo, sin contar esperas)` : ""}. ¿Es la ETA? Toca el botón o escribe otra hora (ej: 12:30).`;
    case "retiro":
      return state.horaSalida
        ? `¿A qué hora es el retiro? Detecté las ${state.horaSalida} (${fmtFecha(state.fecha)}). Toca el botón si es correcto o escribe otra hora (ej: 7:30).`
        : isExtrasPiazza(state)
          ? "¿A qué hora es el retiro? (ej: 7:00). Con eso calculo la ruta y la hora de llegada al último punto."
          : "¿A qué hora es el retiro (salida del vehículo)? (ej: 7:00)";
    case "eta":
      return isExtrasPiazza(state)
        ? "No pude calcular la hora de llegada con la ruta. ¿A qué hora llegarías al último punto? (ej: 12:30)"
        : QUESTIONS.eta;
    case "km":
      return `¿Cuántos km indica el cliente? Solo la ida: el app los multiplica ×2 al facturar.`;
    case "aplicativo":
      return `¿Número de aplicativo? (1 a ${APLICATIVO_MAX[tipo.zona]})`;
    default:
      return QUESTIONS[field];
  }
};

const fmtFecha = (fecha) => (fecha ? `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}` : "");

export const summary = (state, ctx) => {
  const tipo = TIPOS[state.tipo];
  const driver = ctx.refs.drivers.find((d) => d.id === state.driverId);
  const vehicle = ctx.refs.vehicles.find((v) => v.id === state.vehicleId);
  const client = ctx.refs.clients.find((c) => c.id === state.clientId);
  const zona = zonaDe(state);
  const lines = [
    `Resumen · ${tipo.label}${tipo.zonaVariable ? ` (${zona === "ROMA" ? "Roma" : "Milano"})` : ""}`,
    `Chofer: ${driver ? nameOf(driver) : "-"}`,
    `Vehículo: ${vehicle?.targa ?? "-"}`,
    `Cliente: ${client?.nombre ?? "-"}${state.clientFromCode ? " (por el formato del código)" : state.clientAuto ? " (automático)" : ""}`,
    ...(isExtrasPiazza(state)
      ? [
          `Retiro: ${fmtFecha(state.fecha)} ${state.horaSalida}`,
          state.etaManual
            ? `ETA (la que escribiste): ${fmtFecha(state.etaFecha ?? state.fecha)} ${state.hora}`
            : `Llegada estimada al último punto: ${fmtFecha(state.etaFecha ?? state.fecha)} ${state.hora}${state.rutaMin ? ` (ruta ≈ ${state.rutaKm} km · ${Math.floor(state.rutaMin / 60)} h ${state.rutaMin % 60} min de manejo, sin contar esperas)` : ""}`,
        ]
      : [
          `Retiro: ${fmtFecha(state.fecha)} ${state.horaSalida}`,
          `ETA: ${fmtFecha(state.etaFecha ?? state.fecha)} ${state.hora}`,
        ]),
    `Ruta: ${salidaLabel(state)} → ${state.destinos.join(" → ")}`,
  ];
  if (tipo.aplicativo) lines.push(`Aplicativo: ${state.aplicativoN}`);
  if (tipo.kmCliente) lines.push(`KM del cliente (solo ida): ${state.km}  ·  el app los cuenta ×2 = ${state.km * 2}`);
  else if (state.km > 0) lines.push(`KM: ${state.km}`);
  else lines.push("KM: se calculan solos (circuito completo, aproximado por ciudades)");
  if (tipo.code === "PM" || tipo.code === "PR" || state.codigo) lines.push(`Código: ${state.codigo ?? "automático"}`);
  const desc = descripcionFinal(state);
  lines.push(`Descripción: ${desc.length > 220 ? `${desc.slice(0, 220).trim()}…` : desc}`);
  lines.push("", "¿Confirmo? Responde sí o no. También puedes escribir lo que cambia (ej: ETA 15:00, km 90, chofer Rossi).");
  return lines.join("\n");
};

export const descripcionPorDefecto = (state) => `${TIPOS[state.tipo].label}: ${state.destinos.join(" - ")}`;

// Descripcion final: la escrita (o la automatica) mas los numeros de pedido del cliente que no esten ya dentro.
export const descripcionFinal = (state) => {
  const base = state.descripcion ?? descripcionPorDefecto(state);
  const extra = (state.refs ?? []).filter((r) => !base.includes(r.split(" ")[1]));
  return extra.length ? `${base} · ${extra.join(" · ")}` : base;
};

const recap = (state, ctx) => {
  const parts = [TIPOS[state.tipo].label];
  const driver = ctx.refs.drivers.find((d) => d.id === state.driverId);
  const vehicle = ctx.refs.vehicles.find((v) => v.id === state.vehicleId);
  const client = ctx.refs.clients.find((c) => c.id === state.clientId);
  if (driver) parts.push(nameOf(driver));
  if (vehicle) parts.push(vehicle.targa);
  if (client) parts.push(client.nombre);
  if (state.fechaOk) parts.push(fmtFecha(state.fecha));
  if (state.horaSalida) parts.push(`retiro ${state.horaSalida}`);
  if (state.hora) parts.push(`ETA ${state.hora}`);
  if (state.destinos?.length) parts.push(state.destinos.join(" → "));
  if (state.km > 0) parts.push(`${state.km} km`);
  return `Tengo: ${parts.join(" · ")}`;
};

// Una linea para avisar en el grupo lo que se cargo.
export const groupLine = (state, ctx) => {
  const tipo = TIPOS[state.tipo];
  const driver = ctx.refs.drivers.find((d) => d.id === state.driverId);
  const vehicle = ctx.refs.vehicles.find((v) => v.id === state.vehicleId);
  const client = ctx.refs.clients.find((c) => c.id === state.clientId);
  return [
    tipo.label,
    driver ? nameOf(driver) : null,
    vehicle?.targa,
    client?.nombre,
    state.horaSalida ? `retiro ${state.horaSalida}` : null,
    state.hora ? `ETA ${state.etaFecha && state.etaFecha !== state.fecha ? `${fmtFecha(state.etaFecha)} ` : ""}${state.hora}` : null,
    state.destinos.join(" → "),
  ]
    .filter(Boolean)
    .join(" · ");
};

export const HELP_TEXT = [
  "Para cargar un servicio empieza el mensaje con el tipo:",
  "DM · DHL Milano",
  "DR · DHL Roma",
  "PM · Extras Piazza Milano",
  "PR · Extras Piazza Roma",
  "AB · AB Service",
  "O · Otros",
  "",
  "Ejemplo: DM @Romario @Jared MEDTRONIC, AB123CD, ETA 14:30, Lodi - Piacenza, 85 km, aplicativo 5",
  "Los nombres con que abre el mensaje se ignoran: el chofer y el vehículo siempre te los pregunto yo (o escribe chofer: Nombre, y la targa).",
  "Lo que falte te lo pregunto. Después del vehículo siempre confirmo el DÍA del servicio, la hora de RETIRO (salida del vehículo) y la ETA; si ya los escribiste en el mensaje (domani, 18/10, salida 7:00, ETA 14:30) no los repito, salvo la confirmación del retiro.",
  "En DHL y AB Service los km (solo ida) y el aplicativo (solo DHL) son obligatorios; en Extras y Otros los km se calculan solos. Pasados 15 min del retiro el servicio pasa solo a «En camino».",
  "Extras Piazza (PM/PR): la hora del mensaje es la hora de RETIRO; calculo la hora de llegada al último punto con la ruta y te pido confirmarla o corregirla.",
  "Varios servicios: uno por línea, cada uno con su tipo.",
  "/hoy · servicios de hoy   /deshacer · anula lo último que cargaste (10 min)   cancelar · borra lo que llevamos",
].join("\n");

const YES = /^(si|s|ok|okay|dale|confirmo|confirmar|confirmado|yes|vale|listo|va|de acuerdo|cargar)$/;
const NO = /^(no|n|cancelar|cancela|cancel|salir)$/;

// ---------------------------------------------------------------------------------------------------------------------
// Botones (filas de { text, data }). El servicio los convierte en el teclado de Telegram; al apretar uno, "data" vuelve
// como mensaje (ver telegramAssistant.service.js, callbackToText).
// ---------------------------------------------------------------------------------------------------------------------
const CONFIRM_BUTTONS = [
  [
    { text: "✅ Confirmar", data: "y" },
    { text: "✏️ Editar", data: "e" },
    { text: "❌ Cancelar", data: "n" },
  ],
];
const tipoButtons = () =>
  [["DM", "DR"], ["PM", "PR"], ["AB", "O"]].map((row) => row.map((c) => ({ text: `${c} · ${TIPOS[c].label}`, data: `t:${c}` })));
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const dayLabel = (day) => `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${fmtFecha(day)}`;
const gridButtons = (items, perRow) => {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
};

const driverButtons = (ids, ctx) => ids.map((id) => [{ text: nameOf(ctx.refs.drivers.find((d) => d.id === id)), data: `d:${id}` }]);

const questionButtons = (field, state, ctx) => {
  if (field === "driver" && state.driverCandidates?.length) return driverButtons(state.driverCandidates, ctx);
  if (field === "driver" && ctx.refs.drivers.length <= 40) {
    return gridButtons(ctx.refs.drivers.map((d) => ({ text: nameOf(d), data: `d:${d.id}` })), 2);
  }
  if (field === "vehicle" && ctx.refs.vehicles.length <= 40) {
    const usual = ctx.refs.drivers.find((d) => d.id === state.driverId)?.vehiculoAsignadoId;
    const label = (v) => `${v.id === usual ? "⭐ " : ""}${v.targa}${v.modelo && !/completar/i.test(v.modelo) ? ` · ${v.modelo}` : ""}`;
    const sorted = [...ctx.refs.vehicles].sort((a, b) => (b.id === usual) - (a.id === usual));
    return gridButtons(sorted.map((v) => ({ text: label(v), data: `v:${v.id}` })), 2);
  }
  if (field === "fecha" && ctx.today) {
    const day = (n) => dayLabel(addDays(ctx.today, n));
    return [
      [{ text: `Hoy · ${day(0)}`, data: "f:hoy" }, { text: `Mañana · ${day(1)}`, data: "f:manana" }],
      [{ text: `Pasado · ${day(2)}`, data: "f:pasado" }, { text: `Ayer · ${day(-1)}`, data: "f:ayer" }],
    ];
  }
  if (field === "etaConfirm") return [[{ text: `✅ ${state.hora}`, data: "r" }]];
  if (field === "retiro" && state.horaSalida) return [[{ text: `✅ ${state.horaSalida}`, data: "r" }]];
  if (field === "client" && ctx.refs.clients.length && ctx.refs.clients.length <= 12) {
    return gridButtons(ctx.refs.clients.map((c) => ({ text: c.nombre, data: `c:${c.id}` })), 2);
  }
  return undefined;
};

const FIELD_NAMES = {
  driver: "chofer (escribe «chofer: Nombre»)",
  vehicle: "vehículo",
  client: "cliente",
  fecha: "día del servicio (escribe «hoy», «mañana» o 18/10)",
  eta: "ETA",
  etaConfirm: "ETA",
  retiro: "hora de retiro (escribe «salida 7:00»)",
  destinos: "ruta",
  km: "km",
  aplicativo: "aplicativo",
  descripcion: "descripción",
};

// ---------------------------------------------------------------------------------------------------------------------
// Los mensajes abren con los nombres de la oficina a quien va dirigido ("@Romario GT @Jared Bolaños GT ..."): no son el chofer.
// Se saltan los primeros nombres (con "@" o de alguna persona del app, con su apellido) hasta la primera palabra que no lo es.
// ---------------------------------------------------------------------------------------------------------------------
const NAME_STOP = new Set(["eta", "ore", "km", "per", "verso", "app", "order", "ordine", "shipment", "asap", "ruta", "desc", "hoy", "oggi", "domani", "manana", "sale", "salida", "retiro", "aplicativo", "para", "con", "il", "la", "un", "una", "el", "de", "del", "di", "a", "e", "y", "in"]);
// Apodos de la oficina que no estan escritos igual en el app (ej. "Mauro Sinelli"); se pueden sumar con TELEGRAM_NOMBRES_OFICINA.
const EXTRA_STAFF_TOKENS = ["sinelli", ...(process.env.TELEGRAM_NOMBRES_OFICINA ?? "").split(",").map((t) => norm(t)).filter(Boolean)];

export const stripLeadingNames = (text, ctx) => {
  // Se recorre palabra por palabra pero se devuelve el resto del texto ORIGINAL: los saltos de linea importan (rutas de Extras Piazza).
  const tokens = [...text.matchAll(/\S+/g)];
  const words = tokens.map((t) => t[0]);
  const people = new Set([...ctx.refs.drivers.flatMap((d) => norm(`${d.nombre} ${d.apellido}`).split(" ")).filter((t) => t.length >= 3), ...EXTRA_STAFF_TOKENS]);
  const clientTokens = new Set(ctx.refs.clients.flatMap((c) => norm(c.nombre).split(" ")).filter((t) => t.length >= 2));
  const alpha = (w) => /^[\p{L}'’.-]+$/u.test(w.replace(/^@/, "").replace(/[,;:]+$/, ""));
  let i = 0;
  for (let groups = 0; i < words.length && groups < 5; ) {
    const w = norm(words[i]);
    if (w === "gt" || w === "") {
      i += 1;
      continue;
    }
    if (!(words[i].startsWith("@") || people.has(w)) || !alpha(words[i])) break;
    i += 1;
    const next = words[i];
    const nw = next ? norm(next) : "";
    // Un segundo nombre/apellido pegado al primero: conocido, o con mayuscula inicial y sin ser cliente ni palabra clave.
    if (next && nw !== "gt" && !next.startsWith("@") && alpha(next) && !NAME_STOP.has(nw) && !clientTokens.has(nw) && (people.has(nw) || /^\p{Lu}\p{Ll}/u.test(next))) i += 1;
    groups += 1;
  }
  return i < tokens.length ? text.slice(tokens[i].index) : "";
};

// ---------------------------------------------------------------------------------------------------------------------
// Avanza un servicio con un texto: entiende lo que trae, completa lo automatico y valida. No contesta nada.
// ---------------------------------------------------------------------------------------------------------------------
const advance = async (prevState, body, ctx, { pending, isNew }) => {
  let found = {};
  let leftover = [];
  let notFound = null;
  let routeLabeled = false;
  const state0 = prevState;
  // Mensaje nuevo: el texto despues del comando ES la descripcion del servicio, tal cual; y se saltan los nombres de la oficina con
  // que abre para entender el resto.
  const rawBody = body.trim();
  if (isNew) body = stripLeadingNames(body, ctx);
  if (pending === "descripcion" && body.trim()) found = { descripcion: body.trim() };
  else if (pending === "km" && /^\s*\d+(?:[.,]\d+)?\s*(?:km)?\s*$/i.test(body)) found = { km: toNumber(body) };
  else if (pending === "aplicativo" && /^\s*\d{1,2}\s*$/.test(body)) found = { aplicativoN: Number(body) };
  else if ((pending === "eta" || pending === "etaConfirm") && /^\s*(\d{1,2})(?:[:.h]?([0-5]\d))?\s*$/.test(body) && Number(/^\s*(\d{1,2})/.exec(body)[1]) <= 23) {
    const t = /^\s*(\d{1,2})(?:[:.h]?([0-5]\d))?\s*$/.exec(body);
    found = { hora: hhmm(t[1], t[2]) };
  } else if (pending === "etaConfirm" && YES.test(norm(body))) found = { etaOk: true };
  else if (pending === "retiro" && YES.test(norm(body)) && state0.horaSalida) found = { retiroOk: true };
  else if (pending === "retiro" && /^\s*(\d{1,2})(?:[:.h]?([0-5]\d))?\s*$/.test(body) && Number(/^\s*(\d{1,2})/.exec(body)[1]) <= 23) {
    const t = /^\s*(\d{1,2})(?:[:.h]?([0-5]\d))?\s*$/.exec(body);
    found = { horaSalida: hhmm(t[1], t[2]), retiroOk: true };
  }
  else {
    const only = pending === "driver" && state0.driverCandidates?.length ? state0.driverCandidates : undefined;
    ({ found, leftover, routeLabeled } = extractFields(body, ctx, { tipo: state0.tipo, onlyDrivers: only, allowDriver: pending === "driver" }));
    if (pending === "retiro" && found.horaSalida) found.retiroOk = true;
    // Respuesta pelada a lo que se pregunto: la ruta se lee entera como ciudades.
    if (pending === "destinos" && !found.destinos && leftover.length) found.destinos = leftover.splice(0);
    // Mientras se espera un chofer/vehiculo/cliente, ciudades sueltas sin "ruta:" nunca son la ruta (suele ser un nombre que no se
    // encontro o una pregunta). Con la ruta ya cargada tampoco la reemplazan, salvo al confirmar con 2 o mas ciudades.
    const identity = { driver: ["driverId", "choferes"], vehicle: ["targa", "vehículos"], client: ["clientId", "clientes"] }[pending];
    const replacesRoute = state0.stage === "confirm" && found.destinos?.length >= 2;
    const keepsRoute = Boolean(state0.destinos?.length) && !replacesRoute && pending !== "destinos" && !isNew;
    if (found.destinos && !routeLabeled && (identity || keepsRoute)) {
      if (identity && !found[identity[0]] && !found.driverCandidates) notFound = `No encontré «${found.destinos.join(" ")}» entre los ${identity[1]}.`;
      delete found.destinos;
    }
  }

  // IA solo si quedo texto largo sin ubicar y todavia falta algo (o la ruta es solo una suposicion). Lo que la IA encuentra pisa
  // la ruta supuesta; lo demas solo completa lo que falta.
  const weakRoute = Boolean(found.destinos) && !routeLabeled && leftover.length > 0;
  let usedAi = false;
  if (leftover.length && ctx.aiExtract) {
    const draft = await applyDefaults(merge(state0, found, ctx), ctx);
    if (missingFields(draft).length || weakRoute) {
      const ai = await ctx.aiExtract({ text: body, state: draft, leftover });
      if (ai) {
        usedAi = true;
        const { destinos, ...rest } = ai;
        if (isExtrasPiazza(state0)) {
          if (rest.hora && !found.horaSalida && !rest.horaSalida) found.horaSalida = rest.hora;
          delete rest.hora;
        }
        if (destinos?.length && (weakRoute || !found.destinos)) found.destinos = destinos;
        for (const [k, v] of Object.entries(rest)) if (v != null && found[k] == null) found[k] = v;
      }
    }
  }
  if (isNew && rawBody && !found.descripcion) found.descripcion = rawBody;

  const hadInput = Object.keys(found).length > 0;
  const state = await applyDefaults(merge(state0, found, ctx), ctx);

  const warnings = notFound ? [notFound] : [];
  // DHL, AB y Otros: la fecha es la del retiro; si la ETA es una hora anterior al retiro, llega pasada la medianoche.
  if (!isExtrasPiazza(state)) {
    if (state.horaSalida && state.hora && state.horaSalida > state.hora) {
      state.etaFecha = addDays(state.fecha, 1);
      warnings.push(`La ETA (${state.hora}) es anterior al retiro (${state.horaSalida}): la tomé como del día siguiente (${fmtFecha(state.etaFecha)}). Si no es así, corrige la hora.`);
    } else state.etaFecha = null;
  }
  if (state.fecha && found.fecha && (state.fecha < addDays(ctx.today, -7) || state.fecha > addDays(ctx.today, 60))) {
    warnings.push(`La fecha ${fmtFecha(state.fecha)}/${state.fecha.slice(0, 4)} queda lejos de hoy. Revisa que sea correcta.`);
  }
  if (found.km != null && !(found.km > 0 && found.km < 5000)) {
    warnings.push("Los km tienen que ser un número entre 1 y 4999.");
    state.km = null;
  }
  if (state.aplicativoN != null) {
    const max = APLICATIVO_MAX[zonaDe(state) ?? "MILANO"];
    if (!(state.aplicativoN >= 1 && state.aplicativoN <= max)) {
      warnings.push(`El aplicativo va de 1 a ${max}.`);
      state.aplicativoN = null;
    }
  }
  const withEta = await ensureEta(state, ctx);
  return { state: withEta, hadInput, warnings, missing: missingFields(withEta) };
};

// Extras Piazza: con la hora de retiro y la ruta se calcula la llegada al ultimo punto (manejo, sin esperas). Solo se vuelve a
// calcular si cambia el retiro o la ruta; una ETA escrita a mano no se toca.
const ensureEta = async (state, ctx) => {
  if (!isExtrasPiazza(state) || state.etaManual || !retiroReady(state) || !state.destinos?.length) return state;
  const key = `${state.fecha}|${state.horaSalida}|${zonaDe(state)}|${state.destinos.join(">")}`;
  if (state.etaKey === key && state.hora) return state;
  const est = ctx.estimateRoute ? await ctx.estimateRoute(state) : null;
  if (!est) return { ...state, etaFailed: true, etaKey: key };
  const end = new Date(romeLocalToDate(state.fecha, state.horaSalida).getTime() + Math.round(est.duracionMin) * 60000);
  return {
    ...state,
    etaFailed: false,
    etaOk: false,
    etaKey: key,
    hora: romeHHMM(end),
    etaFecha: romeDay(end),
    rutaKm: Math.round(est.distanciaKm * 10) / 10,
    rutaMin: Math.round(est.duracionMin),
  };
};

// Resumen de confirmacion con los avisos (de lo entendido y de choques con otros servicios).
const confirmReply = async (state, ctx, warnings) => {
  const extra = [...warnings, ...((await ctx.checkConflicts?.(state)) ?? [])];
  const head = extra.map((w) => `⚠️ ${w}`);
  return { reply: [...head, summary(state, ctx)].join("\n"), buttons: CONFIRM_BUTTONS };
};

const oneLine = (state, ctx) => recap(state, ctx).replace(/^Tengo: /, "");

const minutesOf = (s) => Date.UTC(Number(s.fecha.slice(0, 4)), Number(s.fecha.slice(5, 7)) - 1, Number(s.fecha.slice(8, 10)), ...s.hora.split(":").map(Number)) / 60000;

// Dos servicios del mismo mensaje con el mismo chofer o vehiculo a menos de 90 minutos.
const batchOverlaps = (items, ctx) => {
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (Math.abs(minutesOf(a) - minutesOf(b)) > 90) continue;
      if (a.driverId === b.driverId) {
        const d = ctx.refs.drivers.find((x) => x.id === a.driverId);
        out.push(`Servicios ${i + 1} y ${j + 1}: ${d ? nameOf(d) : "el chofer"} tiene dos servicios con menos de 90 minutos de diferencia.`);
      } else if (a.vehicleId === b.vehicleId) {
        const v = ctx.refs.vehicles.find((x) => x.id === a.vehicleId);
        out.push(`Servicios ${i + 1} y ${j + 1}: el vehículo ${v?.targa ?? ""} está en dos servicios con menos de 90 minutos de diferencia.`);
      }
    }
  }
  return out;
};

// Varias lineas, cada una con su comando: se entienden por separado y se cargan juntas.
const splitGroups = (text) => {
  const groups = [];
  for (const line of text.split("\n")) {
    if (parseCommand(line, { strict: true })) groups.push(line);
    else if (groups.length && line.trim()) groups[groups.length - 1] += `, ${line.trim()}`;
  }
  return groups;
};
const isBatch = (text) => text.split("\n").filter((l) => parseCommand(l, { strict: true })).length >= 2;

const handleBatch = async (text, ctx) => {
  const items = [];
  const problems = [];
  const notes = [];
  for (const [i, group] of splitGroups(text).entries()) {
    const cmd = parseCommand(group, { strict: true });
    const adv = await advance({ ...newState(cmd.tipo.code), autoRetiro: true }, cmd.rest, ctx, { pending: null, isNew: true });
    if (adv.missing.length) {
      problems.push(`Línea ${i + 1} (${cmd.tipo.label}): falta ${adv.missing.map((f) => FIELD_NAMES[f]).join(", ")}.`);
      continue;
    }
    const conflicts = [...adv.warnings, ...((await ctx.checkConflicts?.(adv.state)) ?? [])];
    items.push(adv.state);
    for (const c of conflicts) notes.push(`Servicio ${items.length}: ${c}`);
  }
  return finishBatch(items, problems, notes, ctx);
};

// Arma la respuesta de un lote ya entendido (items completos, problems = lineas que faltan).
const finishBatch = (items, problems, notes, ctx) => {
  notes.push(...batchOverlaps(items, ctx));
  if (items.length === 0) {
    return { state: null, reply: ["No pude cargar ninguna:", ...problems, "Reenvíalas completas."].join("\n"), action: null };
  }
  const lines = [`Entendí ${items.length} servicio${items.length > 1 ? "s" : ""}:`, ...items.map((s, i) => `${i + 1}) ${oneLine(s, ctx)}`)];
  if (notes.length) lines.push("", ...notes.map((c) => `⚠️ ${c}`));
  if (problems.length) lines.push("", "Faltan datos (estas líneas no se cargan, reenvíalas completas después):", ...problems);
  lines.push("", `¿Cargo ${items.length === 1 ? "el servicio" : `los ${items.length}`}? Responde sí o no.`);
  return {
    state: { v: 2, batch: items, stage: "confirm" },
    reply: lines.join("\n"),
    buttons: [[{ text: `✅ Cargar ${items.length}`, data: "y" }, { text: "❌ Cancelar", data: "n" }]],
    action: null,
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Un mensaje entrante -> { state, reply, buttons?, action }
// action: "create" (hay que cargar el servicio con state, o state.batch si son varios) | "cancel" | null
// ---------------------------------------------------------------------------------------------------------------------
export const handleMessage = async (prevState, rawText, ctx) => {
  const text = rawText.trim();
  const n = norm(text);

  if (/^\/(start|ayuda|help)\b/i.test(text)) return { state: prevState, reply: HELP_TEXT, buttons: tipoButtons(), action: null };
  if (/^\/?(cancelar|cancel)$/i.test(text) || (prevState && NO.test(n))) {
    return { state: null, reply: prevState ? "Cancelado, no cargué nada." : "No hay nada en curso.", action: "cancel" };
  }

  if (isBatch(text)) return handleBatch(text, ctx);

  const cmd = parseCommand(text);
  let state = prevState;
  let body = text;

  // Varios servicios esperando confirmacion: solo se puede confirmar o cancelar.
  if (state?.batch && !cmd) {
    if (YES.test(n)) return { state, reply: "Cargando los servicios...", action: "create" };
    return {
      state,
      reply: `Tengo ${state.batch.length} servicio${state.batch.length > 1 ? "s" : ""} listo${state.batch.length > 1 ? "s" : ""}. Responde sí para cargar o cancelar.`,
      buttons: [[{ text: "✅ Cargar", data: "y" }, { text: "❌ Cancelar", data: "n" }]],
      action: null,
    };
  }

  if (cmd) {
    state = newState(cmd.tipo.code);
    body = cmd.rest;
  } else if (!state) {
    return { state: null, reply: HELP_TEXT, buttons: tipoButtons(), action: null };
  }

  if (state.stage === "confirm" && !cmd) {
    if (YES.test(n)) return { state, reply: "Cargando el servicio...", action: "create" };
    if (n === "editar") {
      return {
        state,
        reply: "Dime qué cambiar, por ejemplo: ETA 15:00 · km 90 · chofer Rossi · AB123CD · ruta: Lodi - Crema · desc: texto. Después confirma.",
        buttons: [[{ text: "✅ Confirmar", data: "y" }, { text: "❌ Cancelar", data: "n" }]],
        action: null,
      };
    }
  }

  const pending = cmd ? null : state.pending;

  // Pidio la lista de vehiculos.
  if (pending === "vehicle" && /\b(lista|opciones|vehiculos|cuales)\b/.test(n)) {
    return { state, reply: "Estos son los vehículos. Toca uno o escribe la targa.", buttons: questionButtons("vehicle", state, ctx), action: null };
  }

  // Pidio la lista de choferes.
  if (pending === "driver" && /\b(lista|opciones|quienes|choferes)\b/.test(n)) {
    return {
      state,
      reply: "Estos son los choferes activos. Toca uno o escribe su nombre.",
      buttons: gridButtons(ctx.refs.drivers.map((d) => ({ text: nameOf(d), data: `d:${d.id}` })), 2),
      action: null,
    };
  }

  const adv = await advance(state, body, ctx, { pending, isNew: Boolean(cmd) });

  if (state.stage === "confirm" && !cmd && !adv.hadInput) {
    return {
      state: adv.state,
      reply: "No entendí. Responde sí para confirmar, no para cancelar, o dime qué cambiar (ej: ETA 15:00, km 90, chofer Rossi).",
      buttons: CONFIRM_BUTTONS,
      action: null,
    };
  }

  if (adv.missing.length) {
    const next = { ...adv.state, stage: "collect", pending: adv.missing[0] };
    const parts = [...adv.warnings.map((w) => `⚠️ ${w}`), recap(next, ctx), question(adv.missing[0], next, ctx)];
    return { state: next, reply: parts.join("\n"), buttons: questionButtons(adv.missing[0], next, ctx), action: null };
  }
  const confirmed = { ...adv.state, stage: "confirm", pending: null };
  const { reply, buttons } = await confirmReply(confirmed, ctx, adv.warnings);
  return { state: confirmed, reply, buttons, action: null };
};

// ---------------------------------------------------------------------------------------------------------------------
// Estado confirmado -> datos para createRecord
// ---------------------------------------------------------------------------------------------------------------------
export const buildRecordInput = (state) => {
  const tipo = TIPOS[state.tipo];
  const zona = zonaDe(state);
  const data = {
    driverId: state.driverId,
    vehicleId: state.vehicleId,
    clientId: state.clientId,
    eta: romeLocalToDate(state.etaFecha ?? state.fecha, state.hora),
    descripcion: descripcionFinal(state),
    codigo: state.codigo ?? `TG-${randomUUID().slice(0, 8).toUpperCase()}`,
    ciudad: state.destinos.at(-1),
    spedizzione: tipo.spedizzione,
    stops: state.destinos,
  };
  if (zona) data.extrasPiazzaZona = zona;
  if (state.horaSalida) data.fechaRetiro = romeLocalToDate(state.fecha, state.horaSalida);
  if (state.aplicativoN) data.aplicativo = `${zona}_${state.aplicativoN}`;
  if (state.km > 0) data.kilometros = state.km;
  return data;
};
