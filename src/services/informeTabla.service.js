import PDFDocument from "pdfkit";
import { toWinAnsi } from "./memorandumPdf.service.js";

// Informe en tabla (Excel y PDF) generico: titulo, filtros aplicados, fecha de generacion, una fila por registro con color
// segun el tono ("rojo", "naranja", "verde") y, en el Excel, una hoja de resumen. Lo usan los informes de Mancato Pagamento.

const NAVY = "FF0B1F33";
const FILL = { rojo: "FFFDE2E1", naranja: "FFFFF1D6", verde: "FFE3F6E8" };
const PDF_FILL = { rojo: "#fde2e1", naranja: "#fff1d6", verde: "#e3f6e8" };

// columns: [{ key, header, width, numFmt? }]; rows: objetos con esas keys y, opcional, "tono" y "tonoKeys" (celdas a pintar).
// resumen: { nombre, columns: [{ key, header, width, numFmt? }], rows: [...] } (opcional).
export const buildTablaXlsx = async ({ titulo, filtros, generado, columns, rows, hoja = "Informe", resumen }) => {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "ONE DRIVER Express";
  const ws = wb.addWorksheet(hoja, { views: [{ state: "frozen", ySplit: 4 }] });
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  ws.getCell("A1").value = titulo;
  ws.getCell("A1").font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell("A2").value = `Filtros: ${filtros}`;
  ws.getCell("A2").font = { size: 10, color: { argb: "FF6B7785" } };
  ws.getCell("A3").value = `Generado el ${generado} - ${rows.length} registros`;
  ws.getCell("A3").font = { size: 10, color: { argb: "FF6B7785" } };

  const header = ws.getRow(4);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  header.height = 32;

  rows.forEach((r) => {
    const values = {};
    columns.forEach((c) => {
      values[c.key] = r[c.key];
    });
    const row = ws.addRow(values);
    row.alignment = { vertical: "top", wrapText: true };
    row.font = { size: 10 };
    columns.forEach((c) => {
      if (c.numFmt) row.getCell(c.key).numFmt = c.numFmt;
    });
    if (r.tono && FILL[r.tono]) {
      (r.tonoKeys ?? columns.map((c) => c.key)).forEach((k) => {
        row.getCell(k).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[r.tono] } };
      });
    }
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: columns.length } };

  if (resumen) {
    const res = wb.addWorksheet(resumen.nombre);
    res.columns = resumen.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    resumen.rows.forEach((r) => res.addRow(r));
    res.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    res.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    resumen.columns.forEach((c) => {
      if (c.numFmt) res.getColumn(c.key).numFmt = c.numFmt;
    });
  }
  return wb.xlsx.writeBuffer();
};

// pdfColumns: [{ key, header, w }] (anchos en puntos, A4 horizontal: ~780 en total).
export const buildTablaPdf = ({ titulo, filtros, generado, pdfColumns, rows, pie }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 36, bottom: 36, left: 30, right: 30 }, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 30;
    const width = pdfColumns.reduce((s, c) => s + c.w, 0);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0b1f33").text(toWinAnsi(titulo), left, 36);
    doc.font("Helvetica").fontSize(8.5).fillColor("#6b7785").text(toWinAnsi(`Filtros: ${filtros}`), { width });
    doc.text(toWinAnsi(`Generado el ${generado} - ${rows.length} registros`));
    doc.moveDown(0.6);

    const drawHeader = () => {
      const y = doc.y;
      doc.rect(left, y, width, 16).fill("#0b1f33");
      let x = left;
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff");
      pdfColumns.forEach((c) => {
        doc.text(toWinAnsi(c.header), x + 3, y + 4, { width: c.w - 6, lineBreak: false, ellipsis: true });
        x += c.w;
      });
      doc.y = y + 16;
    };
    drawHeader();

    const bottom = doc.page.height - 40;
    rows.forEach((r, i) => {
      const cells = pdfColumns.map((c) => toWinAnsi(r[c.key] == null ? "" : String(r[c.key])));
      doc.font("Helvetica").fontSize(7.5);
      const h = Math.max(14, ...cells.map((t, k) => doc.heightOfString(t, { width: pdfColumns[k].w - 6 }) + 6));
      if (doc.y + h > bottom) {
        doc.addPage();
        doc.y = 36;
        drawHeader();
      }
      const y = doc.y;
      const tone = PDF_FILL[r.tono] ?? (i % 2 ? "#f5f7fa" : null);
      if (tone) doc.rect(left, y, width, h).fill(tone);
      let x = left;
      doc.fillColor("#1f2933");
      cells.forEach((t, k) => {
        doc.text(t, x + 3, y + 3, { width: pdfColumns[k].w - 6 });
        x += pdfColumns[k].w;
      });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.4).strokeColor("#d9dee5").stroke();
      doc.y = y + h;
    });

    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p += 1) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7.5).fillColor("#6b7785")
        .text(`ONE DRIVER Express - ${pie} - pagina ${p + 1} de ${range.count}`, left, doc.page.height - 26, { width, align: "right", lineBreak: false });
    }
    doc.end();
  });
