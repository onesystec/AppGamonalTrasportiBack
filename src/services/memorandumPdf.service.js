import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { MEMO_TIPOS } from "../constants/memorandums.js";
import { fechaLarga, hora } from "../utils/fechaEs.js";

// Documento PDF de un memorandum: cabecera con el logo, numero, datos (fecha, de, para, tipo, asunto), el texto y un pie con paginas.
// Usa las fuentes estandar del PDF (Helvetica), que cubren el espanol (acentos, ñ, ¿ ¡); lo que no cubren (emojis, simbolos raros) se quita.
const LOGO = fileURLToPath(new URL("../../assets/logo.png", import.meta.url));

const NAVY = "#0b1f33";
const GRAY = "#6b7785";
const TEXT = "#1f2933";
const LINE = "#d9dee5";

const MARGIN = 56;
const PAGE_W = 595.28;
const CONTENT_W = PAGE_W - MARGIN * 2;

const EXTRA_OK = new Set(["‘", "’", "“", "”", "–", "—", "•", "…", "€"]);
export const toWinAnsi = (text) =>
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((ch) => ch === "\n" || ch.charCodeAt(0) >= 32 && (ch.charCodeAt(0) <= 255 || EXTRA_OK.has(ch)))
    .join("");

// Texto del cuerpo: parrafos separados por una linea en blanco; las lineas que empiezan con "- " son vinetas.
export const parseBody = (cuerpo) =>
  toWinAnsi(cuerpo)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .reduce((blocks, line) => {
      if (line.trim() === "") {
        blocks.push({ type: "gap" });
      } else if (/^\s*[-*•]\s+/.test(line)) {
        blocks.push({ type: "bullet", text: line.replace(/^\s*[-*•]\s+/, "") });
      } else {
        blocks.push({ type: "p", text: line.trim() });
      }
      return blocks;
    }, [])
    .filter((b, i, all) => !(b.type === "gap" && (i === 0 || all[i - 1].type === "gap")));

export const buildMemorandumPdf = ({ numero, tipo, titulo, cuerpo, emisor, emisorRol, audiencia, fecha, plazoAt, nivelFirma }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: 64, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: { Title: `${numero} - ${toWinAnsi(titulo)}`, Author: "Gamonal Trasporti", Subject: "Memorándum" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Cabecera de marca
    doc.rect(0, 0, PAGE_W, 92).fill(NAVY);
    doc.save().circle(MARGIN + 25, 46, 25).clip().image(LOGO, MARGIN, 21, { width: 50, height: 50 }).restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18).text("Gamonal Driver 2.0", MARGIN + 68, 31, { lineBreak: false });
    doc.fillColor("#9fb3c8").font("Helvetica").fontSize(8.5).text("GESTIÓN DE FLOTA · GAMONAL TRASPORTI", MARGIN + 68, 55, { lineBreak: false, characterSpacing: 1 });

    // Titulo y numero
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text("MEMORÁNDUM", MARGIN, 122, { lineBreak: false });
    doc.fillColor(GRAY).font("Helvetica-Bold").fontSize(11).text(`N.º ${numero}`, MARGIN, 128, { width: CONTENT_W, align: "right", lineBreak: false });
    doc.moveTo(MARGIN, 156).lineTo(PAGE_W - MARGIN, 156).lineWidth(2).strokeColor(NAVY).stroke();

    // Datos
    const rows = [
      ["Fecha", fechaLarga(fecha)],
      ["De", `${emisor} (${emisorRol})`],
      ["Para", audiencia],
      ["Tipo", MEMO_TIPOS[tipo]?.label ?? tipo],
      ...(plazoAt ? [["Confirmar antes de", `${fechaLarga(plazoAt)}, ${hora(plazoAt)}`]] : []),
    ];
    let y = 168;
    for (const [label, value] of rows) {
      doc.fillColor(GRAY).font("Helvetica").fontSize(9.5).text(label.toUpperCase(), MARGIN, y + 2, { width: 120, lineBreak: false, characterSpacing: 0.6 });
      doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(11);
      const h = doc.heightOfString(toWinAnsi(value), { width: CONTENT_W - 130 });
      doc.text(toWinAnsi(value), MARGIN + 130, y, { width: CONTENT_W - 130 });
      y += Math.max(h, 14) + 9;
      doc.moveTo(MARGIN, y - 5).lineTo(PAGE_W - MARGIN, y - 5).lineWidth(0.5).strokeColor(LINE).stroke();
    }

    // Asunto
    y += 10;
    doc.fillColor(GRAY).font("Helvetica").fontSize(9.5).text("ASUNTO", MARGIN, y, { characterSpacing: 0.6 });
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(15).text(toWinAnsi(titulo), MARGIN, y + 14, { width: CONTENT_W });
    doc.moveDown(0.8);

    // Cuerpo
    doc.fillColor(TEXT).font("Helvetica").fontSize(11);
    for (const block of parseBody(cuerpo)) {
      if (block.type === "gap") {
        doc.moveDown(0.6);
      } else if (block.type === "bullet") {
        const top = doc.y;
        doc.text("•", MARGIN + 6, top, { lineBreak: false });
        doc.text(block.text, MARGIN + 22, top, { width: CONTENT_W - 22, lineGap: 3 });
      } else {
        doc.text(block.text, MARGIN, doc.y, { width: CONTENT_W, lineGap: 3 });
      }
    }

    // Cierre
    doc.moveDown(2);
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text(toWinAnsi(emisor), MARGIN, doc.y, { width: CONTENT_W });
    doc.fillColor(GRAY).font("Helvetica").fontSize(10).text(emisorRol, MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(1.5);
    doc.fillColor(GRAY).fontSize(8.5).text(
      nivelFirma === "FIRMA"
        ? "Este documento se abre solo después de que cada destinatario lo firma en la app. Quedan registrados la firma, la fecha y hora y el dispositivo."
        : "Este documento se abre solo después de que cada destinatario confirma en la app que lo ha leído. Quedan registrados la fecha y hora y el dispositivo.",
      MARGIN,
      doc.y,
      { width: CONTENT_W, lineGap: 2 }
    );

    // Pie en todas las paginas
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const footY = doc.page.height - 40;
      doc.moveTo(MARGIN, footY - 8).lineTo(PAGE_W - MARGIN, footY - 8).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.fillColor(GRAY).font("Helvetica").fontSize(8).text(`Gamonal Trasporti · ${numero}`, MARGIN, footY, { lineBreak: false });
      doc.text(`Página ${i + 1} de ${range.count}`, MARGIN, footY, { width: CONTENT_W, align: "right", lineBreak: false });
    }

    doc.end();
  });
