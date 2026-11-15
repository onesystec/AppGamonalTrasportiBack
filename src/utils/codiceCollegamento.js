// Codice di collegamento tra app One Driver: "XXXX-XXXX@host" (https sottinteso) o "XXXX-XXXX@http://host:porta" (solo in sviluppo).
// La parte prima di @ e' il segreto per chiedere il collegamento; la parte dopo e' l'indirizzo dell'API dell'altra app. Senza dipendenze (si prova da solo).

import { isIP } from "node:net";

// Indirizzi che non devono mai essere raggiunti da questa app (reti private, loopback, link-local, ecc.): evita che un codice o una richiesta
// ci facciano chiamare servizi interni (SSRF).
const v4Privato = ([a, b, c]) =>
  a === 0 || a === 10 || a === 127 || a >= 224 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0 && c === 0) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19));

const gruppiV6 = (testo) => {
  let t = testo.toLowerCase();
  const v4 = t.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) t = t.replace(v4[0], `${((+v4[1] << 8) | +v4[2]).toString(16)}:${((+v4[3] << 8) | +v4[4]).toString(16)}`);
  const [testa, coda] = t.split("::");
  const a = testa ? testa.split(":") : [];
  const b = coda === undefined ? [] : coda ? coda.split(":") : [];
  const zeri = coda === undefined ? 0 : 8 - a.length - b.length;
  return [...a, ...Array(Math.max(zeri, 0)).fill("0"), ...b].map((g) => parseInt(g || "0", 16));
};

// true se l'host e' locale/privato: nome interno, IPv4 o IPv6 (anche scritto come ::ffff:a.b.c.d).
export const hostPrivato = (hostname) => {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  const tipo = isIP(h);
  if (tipo === 4) return v4Privato(h.split(".").map(Number));
  if (tipo === 6) {
    const g = gruppiV6(h);
    if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: e ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Privato([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
  }
  return !h.includes(".") || h === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(h);
};

// Quanto vale il codice di collegamento (ore) prima di dover essere rigenerato.
export const codiceScaduto = (creadoAt, { ore = 24, ora = Date.now() } = {}) => {
  const t = creadoAt ? new Date(creadoAt).getTime() : NaN;
  return !Number.isFinite(t) || ora - t > ore * 3600_000 || t > ora + 60_000;
};

export class CodiceNonValido extends Error {}

export const formatoCodice = (segreto, url) => `${segreto}@${url.startsWith("https://") ? url.slice("https://".length) : url}`;

// produzione = true: solo indirizzi pubblici in https (niente localhost o reti private).
// hostPermessi: elenco di host ammessi (vuoto = qualsiasi host pubblico). In produzione si consiglia di fissare solo le app dei propri fornitori.
export const leggiCodice = (codice, { produzione = true, hostPermessi = [] } = {}) => {
  const testo = String(codice ?? "").trim();
  const at = testo.lastIndexOf("@");
  if (at < 1) throw new CodiceNonValido("Codice non valido: deve essere come ABCD-1234@indirizzo-app");
  const segreto = testo.slice(0, at).trim().toUpperCase();
  const host = testo.slice(at + 1).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
  } catch {
    throw new CodiceNonValido("Codice non valido: indirizzo dell'app non riconosciuto");
  }
  if (produzione && (url.protocol !== "https:" || hostPrivato(url.hostname) || url.username || url.password)) {
    throw new CodiceNonValido("Codice non valido: l'indirizzo dell'app deve essere pubblico e in https");
  }
  if (produzione && hostPermessi.length > 0 && !hostPermessi.includes(url.hostname.toLowerCase())) {
    throw new CodiceNonValido("Codice non valido: questa app non è tra quelle ammesse per i collegamenti");
  }
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(segreto)) throw new CodiceNonValido("Codice non valido: la parte prima di @ deve essere come ABCD-1234");
  return { segreto, url: url.origin + url.pathname.replace(/\/+$/, "").replace(/\/api$/, "") };
};

// L'indirizzo che l'altra app ci manda nella richiesta (per richiamarla): stesse regole del codice.
export const urlValida = (url, opzioni) => leggiCodice(`AAAA-AAAA@${url}`, opzioni).url;
