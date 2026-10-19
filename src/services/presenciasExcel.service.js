import { CODIGO_PERMISO, HORAS_ORDINARIAS_DIA } from "../config/presencias.js";
import { esFestivoIT } from "../utils/feriadosIt.js";
import { romeHHMM } from "../utils/romeTime.js";

// Planilla de presencias mensual (MODELO PRESENCIAS GAMONAL TRASPORTI): una hoja con una plaza de 3 filas por chofer
// (O = ordinarias, S = straordinarie, N = varie), los dias del mes en columnas, los codigos de la leyenda y las sumas del mes.
// exceljs se carga recien al generar el archivo: no pesa en la memoria del servidor el resto del tiempo.

const MESES = ["GENNAIO", "FEBBRAIO", "MARZO", "APRILE", "MAGGIO", "GIUGNO", "LUGLIO", "AGOSTO", "SETTEMBRE", "OTTOBRE", "NOVEMBRE", "DICEMBRE"];
const MESES_CORTO = ["Gen.", "Feb.", "Mar.", "Apr.", "Mag.", "Giu.", "Lug.", "Ago.", "Set.", "Ott.", "Nov.", "Dic."];
const LETRA_DIA = ["D", "L", "M", "M", "G", "V", "S"]; // getUTCDay(): 0 = domingo
const FONT = "Arial";

// Festivos de la planilla: los nacionales, mas San Ambrosio (Milan, 7/12) y San Francisco (4/10, festivo nacional desde 2026), que el
// modelo del comercialista ya marca como FS.
const esFestivo = (day) => esFestivoIT(day) || day.slice(5) === "12-07" || (day.slice(5) === "10-04" && Number(day.slice(0, 4)) >= 2026);

const colLetter = (n) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

const MEDIUM = { style: "medium" };
const THIN = { style: "thin" };


const legendLines = [
  "LEGENDA DEI CODICI DA UTILIZZARE PER LA COMPILAZIONE DEL FOGLIO DELLE PRESENZE",
  "",
  "Per una corretta compilazione del foglio delle presenze mensili Vi prego di attenerVi scrupolosamente alla seguenti note:",
  "",
  "1)  scrivere per ciascun dipendente il codice dell'anagrafica da cedolino, il cognome, il nome e la qualifica (il foglio presenze mensili contiene in verticale lo spazio per 10 dipendenti),",
  "2)  nella riga sotto il calendario (giorni da 1 a 31) e sotto le lettere dell’alfabeto corrispondenti ai giorni della settimana, le ore lavorate ordinarie nella riga O, le ore straordinarie nella riga S, le ore varie nella riga N",
  "3)  Usare la seguente terminologia: F = Ferie   A = Assenza   Pnr = Permesso non retribuito",
  "     PR = Permesso retribuito   I = Infortunio   M = Malattia   Cm = Congedo matrimoniale",
  "     Avis = Donazione sangue   FS = Festività   G = Gravidanza/maternità,",
  "4)  Al termine del mese inviare al proprio referente, il file compilato",
  "",
  "Ringraziando per la gentile collaborazione porgo distinti saluti.",
];

const notesLines = (formato) => [
  "COMO SE RELLENO ESTA PLANILLA (generada por Gamonal Driver):",
  `- Horas de un servicio: las mismas que usa Pago a choferes (tiempo de circuito; km / 85 si el circuito pasa de 200 km; horas aprobadas en meses anteriores) más la espera declarada. Un viaje compactado cuenta una sola vez.`,
  `- Fila O: hasta ${HORAS_ORDINARIAS_DIA} h por día (supuesto: el contrato de cada chofer no está guardado en el sistema). Lo que pase de ${HORAS_ORDINARIAS_DIA} h va a la fila S.`,
  "- Domingos y festivos trabajados: todas las horas van a la fila S. En los festivos, la fila O lleva FS.",
  "- Fila N: trabajos adicionales aprobados (por el día en que empezaron).",
  "- Permisos aprobados: vacaciones = F, enfermedad = M, permiso = Pnr, otro = A. Los días libres de la oficina no llevan código. Pendientes y rechazados no cuentan.",
  `- Horas en formato ${formato === "hhmm" ? "horas:minutos (6:41)" : "decimal (6,68 = 6 h 41 min)"}. Las sumas del mes se calculan con fórmulas.`,
  "- La hoja «Detalle» lista cada servicio con su día y sus horas para poder revisar cada número.",
];

// choferes: [{ nombre, apellido, dias: { "AAAA-MM-DD": { trabajo, espera, varias } }, permisos: { "AAAA-MM-DD": tipo }, servicios: [...] }]
export const buildPresenciasWorkbook = async ({ month, choferes, formato = "decimal" }) => {
  const { default: ExcelJS } = await import("exceljs");
  const hhmm = formato === "hhmm";
  // Unidad entera de trabajo: minutos (horas:minutos) o centesimas de hora (decimal), para que las sumas cierren sin decimales sueltos.
  const perHour = hhmm ? 60 : 100;
  const toUnits = (hours) => Math.round((hours ?? 0) * perHour);
  const capUnits = HORAS_ORDINARIAS_DIA * perHour;
  const year = Number(month.slice(0, 4));
  const monthIdx = Number(month.slice(5, 7)) - 1;
  const days = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const dayStr = (d) => `${month}-${String(d).padStart(2, "0")}`;
  const weekday = (d) => new Date(Date.UTC(year, monthIdx, d)).getUTCDay();

  const wb = new ExcelJS.Workbook();
  wb.creator = "Gamonal Driver";
  wb.calcProperties.fullCalcOnLoad = true;

  // ---- Leyenda
  const leg = wb.addWorksheet("Leyenda");
  leg.getColumn(1).width = 150;
  legendLines.forEach((text, i) => {
    const cell = leg.getCell(i + 1, 1);
    cell.value = text;
    cell.font = { name: FONT, size: 10, bold: i === 0 };
  });
  notesLines(formato).forEach((text, i) => {
    const cell = leg.getCell(legendLines.length + 3 + i, 1);
    cell.value = text;
    cell.font = { name: FONT, size: 10, bold: i === 0 };
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  // ---- Hoja del mes
  const ws = wb.addWorksheet(`${MESES_CORTO[monthIdx]} ${year}`, { views: [{ state: "frozen", xSplit: 3, ySplit: 3 }] });
  const firstDay = 4; // columna D
  const lastDay = firstDay + days - 1;
  const sumCol = lastDay + 1; // Ore lavorat / straordinar / Permessi
  const lastCol = sumCol + 3;
  ws.getColumn(1).width = 4.5;
  ws.getColumn(2).width = 24;
  ws.getColumn(3).width = 3.6;
  for (let c = firstDay; c <= lastDay; c++) ws.getColumn(c).width = hhmm ? 5.6 : 5.9;
  [9.5, 8, 9.5, 8].forEach((w, i) => (ws.getColumn(sumCol + i).width = w));

  const font = (extra = {}) => ({ name: FONT, size: 10, ...extra });
  const set = (r, c, value, opts = {}) => {
    const cell = ws.getCell(r, c);
    if (value !== undefined) cell.value = value;
    cell.font = opts.font ?? font({ bold: opts.bold });
    if (opts.align) cell.alignment = { horizontal: opts.align, vertical: "middle" };
    if (opts.border) cell.border = opts.border;
    if (opts.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
    if (opts.numFmt) cell.numFmt = opts.numFmt;
    return cell;
  };

  // Encabezado (filas 1 a 3)
  set(1, 2, "COGNOME", { bold: true });
  set(2, 2, "NOME", { bold: true });
  set(3, 2, "QUALIFICA + LIV.", { bold: true });
  set(1, firstDay + 15, "ORE DI LAVORO PER CIASCUNA GIORNATA", { bold: true, align: "center" });
  const headRight = [
    ["Ore lavorat", "straordinar", "Permessi"],
    ["Malattie", "Matern.", "Infortuni"],
    ["ACCONTI", "MENSILI", "PAGATI"],
    ["BUONI ", "PASTO", "TICKET"],
  ];
  headRight.forEach((lines, i) => lines.forEach((text, r) => set(r + 1, sumCol + i, text, { align: "left" })));
  for (let c = 1; c <= lastCol; c++) {
    for (let r = 1; r <= 3; r++) {
      const cell = ws.getCell(r, c);
      cell.border = {
        top: r === 1 ? MEDIUM : THIN,
        bottom: r === 3 ? MEDIUM : THIN,
        left: c === 1 || c === sumCol ? MEDIUM : THIN,
        right: c === lastCol ? MEDIUM : THIN,
      };
      if (!cell.font || !cell.font.name) cell.font = font();
    }
  }
  const GREY = "FFC0C0C0";
  for (let d = 1; d <= days; d++) {
    const c = firstDay + d - 1;
    const sunday = weekday(d) === 0;
    set(2, c, d, { bold: true, align: "center" });
    set(3, c, LETRA_DIA[weekday(d)], { font: font({ bold: true, color: sunday ? { argb: "FFFF0000" } : undefined }), align: "center" });
  }

  const valueCell = (units) => (hhmm ? units / 1440 : units / 100);
  const numFmt = hhmm ? "[h]:mm" : "0.00";

  // Plazas de 3 filas por chofer
  let row = 4;
  choferes.forEach((driver, index) => {
    const rows = { O: row, S: row + 1, N: row + 2 };
    const totals = { O: 0, S: 0, N: 0 };
    const cod = { O: "0", S: "S", N: "N" };
    const names = [driver.apellido.toUpperCase(), driver.nombre.toUpperCase(), "AUTISTA"];
    ["O", "S", "N"].forEach((key, i) => {
      const r = rows[key];
      const top = i === 0 ? MEDIUM : THIN;
      const bottom = i === 2 ? MEDIUM : THIN;
      set(r, 1, i === 0 ? index + 1 : undefined, { bold: true, align: "center", border: { left: MEDIUM, right: THIN, top, bottom } });
      set(r, 2, names[i], { font: font({ size: 9 }), border: { left: THIN, right: THIN, top, bottom } });
      set(r, 3, cod[key], { bold: true, align: "center", border: { left: THIN, right: THIN, top, bottom } });
      for (let d = 1; d <= days; d++) {
        const day = dayStr(d);
        const sunday = weekday(d) === 0;
        const holiday = esFestivo(day);
        const cell = set(r, firstDay + d - 1, undefined, {
          font: { name: FONT, size: 8 },
          align: "center",
          border: { left: THIN, right: THIN, top, bottom },
          fill: sunday || holiday ? GREY : undefined,
        });
        const data = driver.dias?.[day];
        const worked = toUnits((data?.trabajo ?? 0) + (data?.espera ?? 0));
        const offDay = sunday || holiday;
        if (key === "O") {
          if (holiday) {
            cell.value = "FS";
            cell.font = { name: FONT, size: 8, color: { argb: "FFFF0000" } };
          } else if (!offDay && worked > 0) {
            const min = Math.min(worked, capUnits);
            cell.value = valueCell(min);
            cell.numFmt = numFmt;
            totals.O += min;
          } else if (!offDay && driver.permisos?.[day] && CODIGO_PERMISO[driver.permisos[day]]) {
            cell.value = CODIGO_PERMISO[driver.permisos[day]];
          }
        } else if (key === "S") {
          const min = offDay ? worked : Math.max(0, worked - capUnits);
          if (min > 0) {
            cell.value = valueCell(min);
            cell.numFmt = numFmt;
            totals.S += min;
          }
        } else {
          const min = toUnits(data?.varias ?? 0);
          if (min > 0) {
            cell.value = valueCell(min);
            cell.numFmt = numFmt;
            totals.N += min;
          }
        }
      }
      // Suma del mes (con su resultado ya calculado, para los visores que no recalculan)
      const sumCell = set(r, sumCol, { formula: `SUM(${colLetter(firstDay)}${r}:${colLetter(lastDay)}${r})`, result: valueCell(totals[key]) }, {
        align: "center",
        border: { left: THIN, right: THIN, top, bottom },
      });
      sumCell.numFmt = numFmt;
      for (let k = 1; k <= 3; k++) {
        set(r, sumCol + k, undefined, {
          align: "center",
          border: { left: THIN, right: k === 3 ? MEDIUM : THIN, top, bottom },
        });
      }
    });
    row += 3;
  });

  // Pie
  row += 1;
  set(row, 1, "DITTA  GAMONAL TRASPORTI SRL", { bold: true });
  set(row, firstDay + 15, `FOGLIO PRESENZE DEL MESE DI ${MESES[monthIdx]} ${year}`, { bold: true });
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  // ---- Detalle (para verificar cada numero)
  const det = wb.addWorksheet("Detalle", { views: [{ state: "frozen", ySplit: 3 }] });
  det.getCell(1, 1).value = `Detalle de las horas de ${MESES[monthIdx].toLowerCase()} ${year}: cada servicio y el día en que se cuenta`;
  det.getCell(1, 1).font = { name: FONT, bold: true, size: 11 };
  const headers = ["Chofer", "Día", "Hora", "Código", "Cliente", "Servicio", "Horas de trabajo", "Espera (h)", "Aviso"];
  headers.forEach((t, i) => {
    const cell = det.getCell(3, i + 1);
    cell.value = t;
    cell.font = { name: FONT, bold: true, size: 9, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  det.getRow(3).height = 28;
  [26, 11, 8, 22, 18, 36, 12, 11, 42].forEach((w, i) => (det.getColumn(i + 1).width = w));
  let dr = 4;
  for (const driver of choferes) {
    for (const s of driver.servicios ?? []) {
      const aviso = s.incluidoEnViaje
        ? `Va compactado en ${s.viajeCodigo ?? "otro servicio"}: se cuenta una sola vez`
        : s.sinDato
          ? "Sin circuito ni km calculados: cuenta 0 h"
          : "";
      const vals = [
        `${driver.apellido} ${driver.nombre}`,
        `${s.dia.slice(8, 10)}/${s.dia.slice(5, 7)}/${s.dia.slice(0, 4)}`,
        romeHHMM(s.fecha),
        s.codigo,
        s.cliente,
        s.destino,
        valueCell(toUnits(s.trabajo)),
        valueCell(toUnits(s.espera)),
        aviso,
      ];
      vals.forEach((v, i) => {
        const cell = det.getCell(dr, i + 1);
        cell.value = v;
        cell.font = { name: FONT, size: 9 };
        cell.border = { bottom: { style: "thin", color: { argb: "FFBBBBBB" } } };
        if (i === 6 || i === 7) cell.numFmt = numFmt;
      });
      dr += 1;
    }
  }

  return wb.xlsx.writeBuffer();
};

export const presenciasFileName = (month) => `Presencias_${MESES[Number(month.slice(5, 7)) - 1]}_${month.slice(0, 4)}.xlsx`;
