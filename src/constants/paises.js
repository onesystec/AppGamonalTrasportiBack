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
