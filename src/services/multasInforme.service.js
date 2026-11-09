import PDFDocument from "pdfkit";
import { toWinAnsi } from "./memorandumPdf.service.js";

// Informe de multas (Excel y PDF) con los filtros de la lista: el mismo formato que la "lista maestra" de datos del
// conductor (art. 126-bis): verbale, targa, infraccion, limite legal y dias que faltan, estado del envio, conductor
// declarado, chofer responsable y la multa en si (costo, vencimiento, estado).

const DATI_LABEL = { PENDIENTE: "Pendiente", ENVIADO: "Enviado", NO_REQUERIDO: "No requerido" };
const ESTADO_LABEL = { PENDIENTE: "Pendiente", VENCIDO: "Vencida", PAGADO: "Pagada" };
const QUIEN_LABEL = { CHOFER_PAGO: "Paga el chofer", A_DESCONTAR: "A descontar" };
const TITULAR_LABEL = { SRL: "S.R.L.", INDIVIDUAL: "Individual" };

// Fecha sin hora (Date de Prisma o "AAAA-MM-DD...") -> "dd/mm/aaaa".
const day = (value) => {
  if (!value) return "";
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

const driverName = (m) => (m.driver ? `${m.driver.nombre} ${m.driver.apellido}` : "Sin chofer");

const diasText = (m) => {
  if (m.datiEstado !== "PENDIENTE" || m.datiDiasRestantes == null) return "";
  const d = m.datiDiasRestantes;
  if (d < 0) return `Vencido hace ${-d} d`;
  if (d === 0) return "Vence hoy";
  return `Faltan ${d} d`;
};

const vinculo = (m) => {
  const parts = [];
  if (m.multaOrigen) parts.push(`Sancion por datos de #${m.multaOrigen.numeroVerbale}`);
  if (m.sancionesDati?.length) parts.push(`Sancion por datos: ${m.sancionesDati.map((s) => `#${s.numeroVerbale}`).join(", ")}`);
  return parts.join(" / ");
};

// Filas del informe (mismas columnas en Excel y, resumidas, en PDF).
export const informeRows = (items) =>
  items.map((m, i) => ({
    n: i + 1,
    verbale: m.numeroVerbale,
    targa: m.targa,
    infraccion: [day(m.fechaInfraccion), m.horaInfraccion].filter(Boolean).join(" "),
    recepcion: day(m.fechaRecepcion),
    puntos: m.puntosPatente ? "Si" : "No",
    datiLimite: day(m.datiLimite),
    dias: m.datiEstado === "PENDIENTE" ? m.datiDiasRestantes : null,
    diasText: diasText(m),
    datiEstado: DATI_LABEL[m.datiEstado] ?? "No aplica",
    datiEnviado: day(m.datiEnviadoAt),
    conductor: m.datiConductor ?? "",
    chofer: driverName(m),
    costo: Number(m.costo ?? 0),
    vencePago: day(m.fechaVencimiento),
    estado: ESTADO_LABEL[m.estado] ?? m.estado ?? "",
    quienPaga: QUIEN_LABEL[m.quienPaga] ?? "",
    titular: TITULAR_LABEL[m.titular] ?? "",
    vinculo: vinculo(m),
    comentarios: m.comentarios ?? "",
  }));

const COLUMNS = [
  { key: "n", header: "#", width: 5 },
  { key: "verbale", header: "N. verbale", width: 22 },
  { key: "targa", header: "Targa", width: 10 },
  { key: "infraccion", header: "Infraccion", width: 17 },
  { key: "recepcion", header: "Notificacion / recepcion", width: 13 },
  { key: "puntos", header: "Quita puntos", width: 8 },
  { key: "datiLimite", header: "Limite legal datos (126-bis)", width: 14 },
  { key: "dias", header: "Dias que faltan", width: 9 },
  { key: "datiEstado", header: "Estado datos conductor", width: 13 },
  { key: "datiEnviado", header: "Datos enviados el", width: 12 },
  { key: "conductor", header: "Conductor a declarar", width: 32 },
  { key: "chofer", header: "Chofer responsable", width: 22 },
  { key: "costo", header: "Costo (EUR)", width: 11 },
  { key: "vencePago", header: "Vence pago", width: 12 },
  { key: "estado", header: "Estado multa", width: 11 },
  { key: "quienPaga", header: "Quien paga", width: 14 },
  { key: "titular", header: "Titular", width: 10 },
  { key: "vinculo", header: "Sancion 126-bis vinculada", width: 30 },
  { key: "comentarios", header: "Comentarios", width: 70 },
];

const NAVY = "FF0B1F33";
const RED = "FFFDE2E1";
const ORANGE = "FFFFF1D6";
const GREEN = "FFE3F6E8";

export const buildMultasXlsx = async ({ items, titulo, filtros, generado }) => {
  const { default: ExcelJS } = await import("exceljs");
  const rows = informeRows(items);
  const wb = new ExcelJS.Workbook();
  wb.creator = "ONE DRIVER Express";

  const ws = wb.addWorksheet("Multas", { views: [{ state: "frozen", ySplit: 4 }] });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  ws.getCell("A1").value = titulo;
  ws.getCell("A1").font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell("A2").value = `Filtros: ${filtros}`;
  ws.getCell("A2").font = { size: 10, color: { argb: "FF6B7785" } };
  ws.getCell("A3").value = `Generado el ${generado} - ${rows.length} multas`;
  ws.getCell("A3").font = { size: 10, color: { argb: "FF6B7785" } };

  const header = ws.getRow(4);
  COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  header.height = 32;

  rows.forEach((r) => {
    const row = ws.addRow(r);
    row.alignment = { vertical: "top", wrapText: true };
    row.font = { size: 10 };
    row.getCell("costo").numFmt = "#,##0.00";
    // Color del estado de los datos del conductor: vencido rojo, menos de una semana naranja, enviado verde.
    const fill =
      r.datiEstado === "Enviado" ? GREEN : r.dias != null && r.dias < 0 ? RED : r.dias != null && r.dias <= 7 ? ORANGE : null;
    if (fill) {
      ["datiLimite", "dias", "datiEstado", "datiEnviado"].forEach((k) => {
        row.getCell(k).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      });
    }
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: COLUMNS.length } };

  // Resumen por conductor a declarar (o chofer responsable): cuantas faltan, vencidas y en la proxima semana.
  const res = wb.addWorksheet("Por conductor");
  res.columns = [
    { header: "Conductor a declarar / chofer", key: "quien", width: 40 },
    { header: "Multas", key: "total", width: 9 },
    { header: "Datos pendientes", key: "pend", width: 11 },
    { header: "Datos vencidos", key: "venc", width: 11 },
    { header: "Vencen en 7 dias", key: "semana", width: 11 },
    { header: "Datos enviados", key: "env", width: 11 },
    { header: "Total EUR", key: "eur", width: 12 },
  ];
  const groups = new Map();
  rows.forEach((r) => {
    const quien = r.conductor || r.chofer;
    const g = groups.get(quien) ?? { quien, total: 0, pend: 0, venc: 0, semana: 0, env: 0, eur: 0 };
    g.total += 1;
    g.eur += r.costo;
    if (r.datiEstado === "Pendiente") g.pend += 1;
    if (r.dias != null && r.dias < 0) g.venc += 1;
    if (r.dias != null && r.dias >= 0 && r.dias <= 7) g.semana += 1;
    if (r.datiEstado === "Enviado") g.env += 1;
    groups.set(quien, g);
  });
  [...groups.values()].sort((a, b) => b.pend - a.pend || b.total - a.total).forEach((g) => res.addRow(g));
  res.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  res.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  res.getColumn("eur").numFmt = "#,##0.00";

  return wb.xlsx.writeBuffer();
};

// PDF horizontal con las columnas principales (los comentarios quedan solo en el Excel).
const PDF_COLS = [
  { key: "n", header: "#", w: 18 },
  { key: "verbale", header: "N. verbale", w: 78 },
  { key: "targa", header: "Targa", w: 46 },
  { key: "infraccion", header: "Infraccion", w: 62 },
  { key: "datiLimite", header: "Limite datos", w: 52 },
  { key: "diasText", header: "Plazo", w: 62 },
  { key: "datiEstado", header: "Datos", w: 50 },
  { key: "datiEnviado", header: "Enviados", w: 50 },
  { key: "conductor", header: "Conductor a declarar", w: 128 },
  { key: "chofer", header: "Chofer responsable", w: 88 },
  { key: "costo", header: "EUR", w: 40 },
  { key: "estado", header: "Multa", w: 40 },
];

export const buildMultasPdf = ({ items, titulo, filtros, generado }) =>
  new Promise((resolve, reject) => {
    const rows = informeRows(items);
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 36, bottom: 36, left: 30, right: 30 }, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 30;
    const width = PDF_COLS.reduce((s, c) => s + c.w, 0);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0b1f33").text(toWinAnsi(titulo), left, 36);
    doc.font("Helvetica").fontSize(8.5).fillColor("#6b7785").text(toWinAnsi(`Filtros: ${filtros}`), { width });
    doc.text(toWinAnsi(`Generado el ${generado} - ${rows.length} multas`));
    doc.moveDown(0.6);

    const drawHeader = () => {
      const y = doc.y;
      doc.rect(left, y, width, 16).fill("#0b1f33");
      let x = left;
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff");
      PDF_COLS.forEach((c) => {
        doc.text(c.header, x + 3, y + 4, { width: c.w - 6, lineBreak: false, ellipsis: true });
        x += c.w;
      });
      doc.y = y + 16;
    };
    drawHeader();

    const bottom = doc.page.height - 40;
    rows.forEach((r, i) => {
      const cells = PDF_COLS.map((c) => {
        const v = c.key === "costo" ? r.costo.toFixed(2).replace(".", ",") : r[c.key];
        return toWinAnsi(v == null ? "" : String(v));
      });
      doc.font("Helvetica").fontSize(7.5);
      const h = Math.max(14, ...cells.map((t, k) => doc.heightOfString(t, { width: PDF_COLS[k].w - 6 }) + 6));
      if (doc.y + h > bottom) {
        doc.addPage();
        doc.y = 36;
        drawHeader();
      }
      const y = doc.y;
      const tone = r.datiEstado === "Enviado" ? "#e3f6e8" : r.dias != null && r.dias < 0 ? "#fde2e1" : r.dias != null && r.dias <= 7 ? "#fff1d6" : i % 2 ? "#f5f7fa" : null;
      if (tone) doc.rect(left, y, width, h).fill(tone);
      let x = left;
      doc.fillColor("#1f2933");
      cells.forEach((t, k) => {
        doc.text(t, x + 3, y + 3, { width: PDF_COLS[k].w - 6 });
        x += PDF_COLS[k].w;
      });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.4).strokeColor("#d9dee5").stroke();
      doc.y = y + h;
    });

    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p += 1) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7.5).fillColor("#6b7785")
        .text(`ONE DRIVER Express - Informe de multas - pagina ${p + 1} de ${range.count}`, left, doc.page.height - 26, { width, align: "right", lineBreak: false });
    }
    doc.end();
  });
