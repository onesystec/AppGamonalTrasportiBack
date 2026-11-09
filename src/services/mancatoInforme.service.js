import { buildTablaPdf, buildTablaXlsx } from "./informeTabla.service.js";

// Informe de Mancato Pagamento (Excel y PDF) con los filtros de la lista: aviso, targa, transito, chofer, costo, plazo de
// pago con los dias que faltan, estado, si se subio tarde (mas de 48 h) o fuera de plazo, el servicio y los comentarios.

const ESTADO_LABEL = {
  PENDIENTE: "Pendiente",
  VENCIDO: "Vencido",
  HISTORIAL_VENCIDO: "Vencido (historial)",
  OBSERVADO: "Observado",
  PAGADO: "Pagado",
};
const ASIGNACION_LABEL = {
  AUTO: "Automatica",
  SUGERIDO: "Sugerida",
  CONFIRMADO: "Confirmada",
  MANUAL: "Manual",
  EN_ESPERA: "En espera de servicio",
};

const day = (value) => {
  if (!value) return "";
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

const plazo = (m) => {
  if (m.estado === "PAGADO") return m.pagadoFueraDePlazo ? "Pagado fuera de plazo" : "Pagado";
  const d = m.diasRestantes;
  if (d == null) return "";
  if (d < 0) return `Vencido hace ${-d} d`;
  if (d === 0) return "Vence hoy";
  return `Faltan ${d} d`;
};

const tono = (m) => {
  if (m.estado === "PAGADO") return "verde";
  if (m.estado === "VENCIDO" || m.estado === "HISTORIAL_VENCIDO") return "rojo";
  if (m.estado === "OBSERVADO" || (m.diasRestantes != null && m.diasRestantes <= 1)) return "naranja";
  return null;
};

const rowsOf = (items) =>
  items.map((m, i) => ({
    n: i + 1,
    numero: m.numero,
    targa: m.targa,
    transito: [day(m.fecha), m.horaTransito].filter(Boolean).join(" "),
    chofer: m.driver ? `${m.driver.nombre} ${m.driver.apellido}` : "Sin chofer",
    costo: Number(m.costo ?? 0),
    costoTxt: Number(m.costo ?? 0).toFixed(2).replace(".", ","),
    vence: day(m.fechaVencimiento),
    dias: m.estado === "PAGADO" ? null : m.diasRestantes,
    plazo: plazo(m),
    estado: ESTADO_LABEL[m.estado] ?? m.estado,
    pagadoAt: day(m.pagadoAt),
    subida: m.subidoTarde ? `Tarde (${m.horasHastaSubida} h)` : `${m.horasHastaSubida} h`,
    fueraDePlazo: m.fueraDePlazo ? `Si (${m.diasTarde} d tarde)` : "No",
    servicio: m.servicio ? [m.servicio.codigo, m.servicio.cliente].filter(Boolean).join(" - ") : "",
    asignacion: ASIGNACION_LABEL[m.asignacion] ?? m.asignacion ?? "",
    registrado: day(m.registradoAt),
    comentarios: m.comentarios ?? "",
    tono: tono(m),
    tonoKeys: ["vence", "dias", "plazo", "estado"],
  }));

const COLUMNS = [
  { key: "n", header: "#", width: 5 },
  { key: "numero", header: "N. aviso", width: 20 },
  { key: "targa", header: "Targa", width: 10 },
  { key: "transito", header: "Transito", width: 17 },
  { key: "chofer", header: "Chofer", width: 24 },
  { key: "costo", header: "Costo (EUR)", width: 11, numFmt: "#,##0.00" },
  { key: "vence", header: "Vence pago", width: 12 },
  { key: "dias", header: "Dias que faltan", width: 9 },
  { key: "plazo", header: "Plazo", width: 18 },
  { key: "estado", header: "Estado", width: 13 },
  { key: "pagadoAt", header: "Pagado el", width: 12 },
  { key: "subida", header: "Subido al sistema (h desde el transito)", width: 16 },
  { key: "fueraDePlazo", header: "Subido fuera de plazo", width: 14 },
  { key: "servicio", header: "Servicio", width: 28 },
  { key: "asignacion", header: "Asignacion", width: 16 },
  { key: "registrado", header: "Registrado el", width: 12 },
  { key: "comentarios", header: "Comentarios", width: 60 },
];

const PDF_COLUMNS = [
  { key: "n", header: "#", w: 20 },
  { key: "numero", header: "N. aviso", w: 82 },
  { key: "targa", header: "Targa", w: 48 },
  { key: "transito", header: "Transito", w: 64 },
  { key: "chofer", header: "Chofer", w: 100 },
  { key: "costoTxt", header: "EUR", w: 40 },
  { key: "vence", header: "Vence", w: 50 },
  { key: "plazo", header: "Plazo", w: 76 },
  { key: "estado", header: "Estado", w: 60 },
  { key: "pagadoAt", header: "Pagado el", w: 50 },
  { key: "subida", header: "Subida", w: 54 },
  { key: "servicio", header: "Servicio", w: 136 },
];

const resumenPorChofer = (rows) => {
  const groups = new Map();
  rows.forEach((r) => {
    const g = groups.get(r.chofer) ?? { chofer: r.chofer, total: 0, pendientes: 0, vencidos: 0, pagados: 0, tarde: 0, eurPendiente: 0, eurTotal: 0 };
    g.total += 1;
    g.eurTotal += r.costo;
    if (r.estado === "Pagado") g.pagados += 1;
    else {
      g.eurPendiente += r.costo;
      if (r.estado.startsWith("Vencido")) g.vencidos += 1;
      else g.pendientes += 1;
    }
    if (r.subida.startsWith("Tarde")) g.tarde += 1;
    groups.set(r.chofer, g);
  });
  return {
    nombre: "Por chofer",
    columns: [
      { key: "chofer", header: "Chofer", width: 30 },
      { key: "total", header: "Mancati", width: 9 },
      { key: "pendientes", header: "Pendientes", width: 11 },
      { key: "vencidos", header: "Vencidos", width: 10 },
      { key: "pagados", header: "Pagados", width: 10 },
      { key: "tarde", header: "Subidos tarde (+48 h)", width: 13 },
      { key: "eurPendiente", header: "EUR sin pagar", width: 13, numFmt: "#,##0.00" },
      { key: "eurTotal", header: "EUR total", width: 12, numFmt: "#,##0.00" },
    ],
    rows: [...groups.values()].sort((a, b) => b.eurPendiente - a.eurPendiente || b.total - a.total),
  };
};

export const buildMancatoInforme = ({ items, formato, filtros, generado }) => {
  const rows = rowsOf(items);
  const titulo = "Informe de Mancato Pagamento";
  if (formato === "pdf") return buildTablaPdf({ titulo, filtros, generado, pdfColumns: PDF_COLUMNS, rows, pie: "Informe de Mancato Pagamento" });
  return buildTablaXlsx({ titulo, filtros, generado, columns: COLUMNS, rows, hoja: "Mancati", resumen: resumenPorChofer(rows) });
};
