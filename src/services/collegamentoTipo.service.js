// Tipo de un servicio que llega de una app conectada (App Piazza): DHL, AB Service o Extra Piazza, deducido SOLO por reglas (sin IA y sin costo) del texto y de los datos que manda,
// igual que hace el lector de textos de la oficina (servicioTexto.service.js): el cliente, las palabras del mensaje y la forma de los numeros (Shipment y Order).
//  - AB Service: cliente AB / "AB Service", el deposito de Romanengo, Shipment 182xxxxxx u Order 0xxxxxxxx.
//  - DHL: cliente DHL, "DHL" o las lineas "Ship To ..." del portal, Shipment 16xxxxxxx / 17xxxxxxx u Order 116xxxxxxx.
//  - Si el texto no dice nada de eso: Extra Piazza.
// Si la otra app manda el tipo expresamente (campo "tipo"), manda ese.

const plano = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();

const AB_CLIENTE = /^\s*A\.?\s*B\.?(?:\s*[-.]?\s*SERVICE)?\s*$/;
const AB_TEXTO = /\bA\.?\s*B\.?\s*[-._ ]*SERVICE\b|\bABSERVICE\b|\bROMANENGO\b/;
const DHL_TEXTO = /\bDHL\b|\bSHIP\s*TO\s*(?:ADDRESS|CITY|POSTAL|COUNTRY)\b/;

export const TIPOS_SERVICIO = ["AB_SERVICE", "DHL", "EXTRA_PIAZZA"];

const deTipoExplicito = (tipo) => {
  const t = plano(tipo);
  if (!t) return null;
  if (/\bA\.?\s*B\b|AB[_ ]?SERVICE/.test(t)) return "AB_SERVICE";
  if (/DHL/.test(t)) return "DHL";
  if (/EXTRA|PIAZZA/.test(t)) return "EXTRA_PIAZZA";
  return null;
};

export const detectarTipoServicio = ({ tipo, cliente, texto, shipment, orderNumero, codigo } = {}) => {
  const explicito = deTipoExplicito(tipo);
  if (explicito) return explicito;
  const numeros = [shipment, codigo, orderNumero].map((n) => String(n ?? "").trim()).filter(Boolean);
  const cuerpo = plano(texto);
  const cli = plano(cliente);

  const ab =
    AB_CLIENTE.test(cli) ||
    /\bA\.?\s*B\.?\s*[-._ ]*SERVICE\b|\bABSERVICE\b/.test(cli) ||
    AB_TEXTO.test(cuerpo) ||
    numeros.some((n) => /^182\d{6}$/.test(n)) ||
    (orderNumero && /^0\d{8}$/.test(String(orderNumero).trim()) && numeros.some((n) => /^\d{9}$/.test(n)));
  if (ab) return "AB_SERVICE";

  const dhl = /\bDHL\b/.test(cli) || DHL_TEXTO.test(cuerpo) || numeros.some((n) => /^1[67]\d{7}$/.test(n) || /^116\d{7}$/.test(n));
  if (dhl) return "DHL";
  return "EXTRA_PIAZZA";
};

// Tipo de la solicitud de Gamonal (ver constants/solicitudes.js) y su zona. En DHL, Roma si la ciudad o el destino lo dicen; AB Service sale siempre de Milano.
export const tipoDeSolicitud = (tipo, { ciudad, destino } = {}) => {
  const roma = /\bROMA\b/.test(plano(`${ciudad ?? ""} ${tipo === "DHL" ? (destino ?? "") : ""}`));
  if (tipo === "AB_SERVICE") return { servicio: "AB_SERVICE", zona: null };
  if (tipo === "DHL") return { servicio: roma ? "DHL_ROMA" : "DHL_MILANO", zona: null };
  return { servicio: "EXTRA_PIAZZA", zona: roma ? "ROMA" : "MILANO" };
};

// Los datos de lo que manda la otra app, juntos, para leer el tipo: el servicio tal como llega o lo que se guardo (datosRemotos).
export const textoDeServicio = (s) => [s.cliente, s.codigo, s.shipment, s.orderNumero, s.mittente, s.ritiro, s.destinazione, ...(s.tappe ?? []), s.note].filter(Boolean).join("\n");
