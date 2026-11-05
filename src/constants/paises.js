// Paises de las entregas (codigo ISO de 2 letras). Italia es lo normal: solo se marca el pais cuando la entrega es fuera de Italia o el texto lo dice.
export const PAISES = [
  "IT", "FR", "DE", "CH", "AT", "ES", "PT", "BE", "NL", "LU", "GB", "IE", "DK", "SE", "NO", "FI", "IS", "PL", "CZ", "SK", "HU", "SI", "HR", "BA", "RS", "ME", "MK", "AL",
  "XK", "GR", "BG", "RO", "MD", "UA", "LT", "LV", "EE", "MT", "CY", "SM", "VA", "MC", "AD", "LI", "TR", "MA", "TN", "DZ", "EG", "US", "CN",
];

const sinAcentos = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Nombre del pais -> codigo, en ingles, italiano, espanol, frances y aleman (el portal de DHL escribe "FRANCE").
const POR_NOMBRE = new Map();
for (const lang of ["en", "it", "es", "fr", "de"]) {
  const names = new Intl.DisplayNames([lang], { type: "region" });
  for (const code of PAISES) POR_NOMBRE.set(sinAcentos(names.of(code)), code);
}
const ALIAS = { uk: "GB", "united kingdom": "GB", "great britain": "GB", usa: "US", "czech republic": "CZ", holland: "NL", "the netherlands": "NL", turkiye: "TR" };

// "FRANCE", "France", "FR", "Francia" -> "FR". null si no se reconoce.
export const parsePais = (text) => {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2}$/.test(raw) && PAISES.includes(raw.toUpperCase())) return raw.toUpperCase();
  const key = sinAcentos(raw);
  return POR_NOMBRE.get(key) ?? ALIAS[key] ?? null;
};

// Formato del codigo postal (CAP) de cada pais: sirve para comprobar que el CAP del texto corresponde al pais. Un pais sin formato aca no se comprueba.
const CINCO = /^\d{5}$/;
const CUATRO = /^\d{4}$/;
const TRES_DOS = /^\d{3}\s?\d{2}$/;
const FORMATO_CAP = {
  IT: CINCO, FR: CINCO, DE: CINCO, ES: CINCO, HR: CINCO, FI: CINCO, RS: CINCO, ME: CINCO, BA: CINCO, XK: CINCO, TR: CINCO, MA: CINCO, DZ: CINCO, EG: CINCO,
  UA: CINCO, EE: CINCO, SM: CINCO, MC: CINCO, VA: CINCO,
  CH: CUATRO, AT: CUATRO, BE: CUATRO, LU: CUATRO, DK: CUATRO, NO: CUATRO, HU: CUATRO, SI: CUATRO, BG: CUATRO, TN: CUATRO, LI: CUATRO, MK: CUATRO, AL: CUATRO, CY: CUATRO,
  SE: TRES_DOS, GR: TRES_DOS, CZ: TRES_DOS, SK: TRES_DOS,
  NL: /^\d{4}\s?[A-Za-z]{2}$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/,
  PT: /^\d{4}(-\d{3})?$/,
  PL: /^\d{2}-?\d{3}$/,
  RO: /^\d{6}$/,
  CN: /^\d{6}$/,
  IS: /^\d{3}$/,
  US: /^\d{5}(-\d{4})?$/,
  LT: /^(LT-?)?\d{5}$/i,
  LV: /^(LV-?)?\d{4}$/i,
  MD: /^(MD-?)?\d{4}$/i,
  MT: /^[A-Za-z]{3}\s?\d{2,4}$/,
  AD: /^AD\d{3}$/i,
  IE: /^[A-Za-z]\d{2}\s?[A-Za-z\d]{4}$/,
};

// true = el CAP tiene el formato del pais; false = no lo tiene; null = no se puede comprobar (pais sin formato conocido o sin CAP).
export const capCoincideConPais = (cap, pais) => {
  const formato = FORMATO_CAP[pais];
  const valor = String(cap ?? "").trim();
  if (!formato || !valor) return null;
  return formato.test(valor);
};

// Los CAP se comparan sin espacios, guiones ni mayusculas ("2511 CV" = "2511CV").
export const normCap = (cap) => String(cap ?? "").replace(/[\s-]/g, "").toUpperCase();
