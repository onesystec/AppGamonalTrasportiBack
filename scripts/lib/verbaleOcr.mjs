// Lee el texto reconocido (OCR) de un verbale escaneado y saca lo que sirve para relacionar la multa con un servicio:
// la targa, el dia y la hora reales de la infraccion y, en las multas por no comunicar los datos del conductor, el verbale original.
//
// La infraccion siempre es ANTERIOR a las demas fechas del documento (la del verbale, la de envio, la de notificacion), asi que de
// todas las fechas candidatas ("... in data 07/07/2025 alle ore 08:06 ...", "commessa il 06-02-2026", "Data / ora: 21.04.2026, 21:12")
// se toma la mas antigua. Las fechas sueltas (certificados de taratura, homologaciones) no cuentan.

const TARGA_RE = /\b[A-Z]{2}\s?\d{3}\s?[A-Z]{2}\b/g;
const D = String.raw`(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})`;
// Fecha + hora: "07/07/2025 alle ore 08:06", "21.04.2026, 21:12 Uhr", "03/03/2025 alle ore 7:17:50".
const DATE_TIME_RE = new RegExp(String.raw`${D}\s*(?:\||,|-)?\s*(?:alle\s*ore|ore|ora|alle|h\.?|um)?\s*[:]?\s*(\d{1,2})\s*[:.]\s*(\d{2})`, "gi");
// Fecha con el verbo de la infraccion, sin hora: "commessa il 06-02-2026", "In data 05-03-2025 e stato perpetrato".
const DATE_VERB_RE = [
  new RegExp(String.raw`commess[aoi]\s+(?:il|in\s+data)\s+${D}`, "gi"),
  new RegExp(String.raw`in\s+data\s+${D}\s+e\s+stato\s+(?:perpetrato|commesso|accertato)`, "gi"),
];
const REF_VERBALE_RE = /verbale\s+(?:nr\.?|n\.?|n°)\s*(\d{3}\s*[/ ]\s*\d{6,8})/gi;

const pad = (n) => String(n).padStart(2, "0");

const toIsoDay = (d, m, y) => {
  const year = y < 100 ? 2000 + y : y;
  if (m < 1 || m > 12 || d < 1 || d > 31 || year < 2024 || year > 2030) return null;
  const check = new Date(Date.UTC(year, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null;
  return `${year}-${pad(m)}-${pad(d)}`;
};

// Fecha "dd/mm/yyyy" suelta (sin hora) -> yyyy-mm-dd.
export const dayFromSlash = (s) => {
  const m = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/.exec(s ?? "");
  return m ? toIsoDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

export const parseVerbale = (rawText, { knownTargas = new Set(), recepcionDay = null } = {}) => {
  const text = strip((rawText ?? "").replace(/ /g, " "));

  // Targa: la primera que sea de un vehiculo de la flota; si no, la que aparece junto a "targa/targato".
  const plates = [...text.matchAll(TARGA_RE)].map((m) => m[0].replace(/\s/g, ""));
  let targa = plates.find((p) => knownTargas.has(p)) ?? null;
  if (!targa) {
    const near = /targ(?:a|ato)\s*[:|]?\s*([A-Z]{2}\s?\d{3}\s?[A-Z]{2})/i.exec(text);
    if (near) targa = near[1].replace(/\s/g, "").toUpperCase();
  }

  const found = [];
  const push = (day, hora) => {
    if (!day) return;
    if (recepcionDay && day > recepcionDay) return;
    found.push({ day, hora });
  };
  for (const m of text.matchAll(DATE_TIME_RE)) {
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    if (hh > 23 || mm > 59) continue;
    push(toIsoDay(Number(m[1]), Number(m[2]), Number(m[3])), `${pad(hh)}:${pad(mm)}`);
  }
  for (const re of DATE_VERB_RE) {
    for (const m of text.matchAll(re)) push(toIsoDay(Number(m[1]), Number(m[2]), Number(m[3])), null);
  }
  // Mas antigua primero; si hay dos del mismo dia, la que trae hora.
  found.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : (b.hora ? 1 : 0) - (a.hora ? 1 : 0)));
  const when = found[0] ?? null;

  const referencias = [...new Set([...text.matchAll(REF_VERBALE_RE)].map((m) => m[1].replace(/\s*[/ ]\s*/, "/")))];

  return { targa, fecha: when?.day ?? null, hora: when?.hora ?? null, referencias };
};
