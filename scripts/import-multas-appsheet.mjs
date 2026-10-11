// Importa a la app las multas exportadas de AppSheet (CSV con ";"): una por verbale, con su PDF, su chofer, su vehiculo y el dia/hora
// reales de la infraccion (leidos del PDF con OCR).
//
//   node scripts/import-multas-appsheet.mjs <archivo.csv> --pdfs <carpeta> --ocr <carpeta>             -> informe SIN escribir nada
//   node scripts/import-multas-appsheet.mjs <archivo.csv> --pdfs <carpeta> --ocr <carpeta> --aplicar   -> sube a la base y a R2
//   node scripts/import-multas-appsheet.mjs --revertir <deshacer.json>                                 -> borra lo que subio una corrida
//
//  --pdfs  carpeta con los PDF/fotos descargados, uno por multa: <Id_Multas>.bin
//  --ocr   carpeta con el texto reconocido de cada uno: <Id_Multas>.txt (ver scripts/lib/verbaleOcr.mjs)
//
// Es idempotente: un verbale que ya esta en la base no se vuelve a subir. Si se corta a la mitad, se vuelve a correr y sigue.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { hashPassword } from "../src/utils/password.js";
import { deleteObject, uploadObject } from "../src/services/storage.service.js";
import { compressImage } from "../src/utils/imageProcessor.js";
import { recordAreaKey } from "../src/utils/areaAccess.js";
import { romeLocalToDate } from "../src/utils/romeTime.js";
import { parseVerbale } from "./lib/verbaleOcr.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const REVERT = args.includes("--revertir");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const file = args.find((a, i) => !a.startsWith("--") && !["--pdfs", "--ocr", "--revertir"].includes(args[i - 1]));
const PDF_DIR = opt("--pdfs");
const OCR_DIR = opt("--ocr");
const OUT_DIR = join(homedir(), "Downloads");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const DAY = 24 * 60 * 60 * 1000;

// ---- revertir -------------------------------------------------------------------------------------------------------------------------
if (REVERT) {
  const undo = JSON.parse(readFileSync(opt("--revertir"), "utf8"));
  const { count } = await prisma.multa.deleteMany({ where: { id: { in: undo.multaIds ?? [] } } });
  for (const key of undo.keys ?? []) await deleteObject(key).catch(() => {});
  let users = 0;
  for (const id of undo.userIds ?? []) {
    try {
      await prisma.user.delete({ where: { id } });
      users += 1;
    } catch {
      console.log(`No se pudo borrar el chofer ${id} (tiene otros datos).`);
    }
  }
  console.log(`Borradas ${count} multas, ${(undo.keys ?? []).length} archivos y ${users} choferes.`);
  await prisma.$disconnect();
  process.exit(0);
}

if (!file || !PDF_DIR || !OCR_DIR) {
  console.error("Uso: node scripts/import-multas-appsheet.mjs <archivo.csv> --pdfs <carpeta> --ocr <carpeta> [--aplicar]");
  process.exit(1);
}

// ---- CSV (separador ";", comillas dobles, BOM) ------------------------------------------------------------------------------------
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  const names = header.map((h) => h.trim());
  return body.map((r, i) => ({ _linea: i + 2, ...Object.fromEntries(names.map((n, k) => [n, (r[k] ?? "").trim()])) }));
};
const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// ---- normalizaciones ------------------------------------------------------------------------------------------------------------------
const fold = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const targaOf = (s) => (s ?? "").replace(/\s+/g, "").toUpperCase();
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec((s ?? "").trim());
  if (!m || Number(m[3]) < 2024 || Number(m[3]) > 2030) return null;
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
};
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const dayDate = (day) => new Date(`${day}T00:00:00.000Z`);
const romeToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const montoOf = (raw) => {
  const s = (raw ?? "").replace(/[€\s]/g, "");
  if (!s) return null;
  const n = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, "") : s.replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000000 ? Math.round(n * 100) / 100 : null;
};

// ---- choferes -------------------------------------------------------------------------------------------------------------------------
// Nombres del CSV que se escriben distinto en la app, y los que se crean (inactivos, sin acceso) porque todavia no existen.
const ALIAS = {
  "JUAN CARLOS": "JUAN CARLOS LAZARO",
  "SANTHA NEELAPPAGE": "SHANTHA NEELAPPAGE",
  "NATALIA PLUA": "NATALIA PLUA",
  "MAURO AGOSTINELLLI": "MAURO AGOSTINELLI",
  "YAN GAMONAL": "YAN GLAUBER GAMONAL",
  "MARTIN RODRIGUEZ": "MARTIN RODRIGUEZ",
  "EDWAR GUERRERO": "EDWARD GUERRERO",
};
const CREAR = {
  "JURGEN PALIZA": ["Jurgen", "Paliza"],
  "DOMINICK LEON": ["Dominick", "Leon"],
  "SHANTHA NEELAPPAGE": ["Shantha", "Neelappage"],
  "EDUARDO SANTA CRUZ": ["Eduardo", "Santa Cruz"],
  "ADOLFO ROSALES": ["Adolfo", "Rosales"],
  "DENNIS INGLES": ["Dennis", "Ingles"],
  "DIEGO MOLINA": ["Diego", "Molina"],
  "MARTIN RODRIGUEZ": ["Martín", "Rodríguez"],
  "ANTONIO RIVERA": ["Antonio", "Rivera"],
  "LUIS POMA": ["Luis", "Poma"],
  "ELSA DAVILA": ["Elsa", "Davila"],
  "EDWARD GUERRERO": ["Edward", "Guerrero"],
  "MARINO ORTEGA": ["Marino", "Ortega"],
};
const EMPRESA_PROFILE = "GAMONAL TRASPORTI";

const [users, vehicles, existing, records] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, estado: true, correoElectronico: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true, area: true, grupo: true } }),
  prisma.multa.findMany({ select: { numeroVerbale: true } }),
  prisma.record.findMany({
    where: { estado: { not: "ANNULLATO" } },
    select: { vehicleId: true, fechaServicio: true, spedizzione: true, extrasPiazzaZona: true },
  }),
]);
const existingNumbers = new Set(existing.map((m) => m.numeroVerbale));
const existingEmails = new Set(users.map((u) => u.correoElectronico.toLowerCase()));
const userByName = new Map();
for (const u of users) {
  const key = fold(`${u.nombre} ${u.apellido}`);
  if (!userByName.has(key) || u.estado === "ACTIVO") userByName.set(key, u);
}
const newUsers = new Map();
const personFor = (raw) => {
  const base = fold(raw);
  if (!base || base === "LIBRE") return null;
  const key = ALIAS[base] ?? base;
  if (userByName.has(key)) return userByName.get(key);
  if (CREAR[key]) {
    if (!newUsers.has(key)) newUsers.set(key, { id: randomUUID(), nombre: CREAR[key][0], apellido: CREAR[key][1] });
    return newUsers.get(key);
  }
  return undefined; // nombre que no se pudo resolver
};

const vehicleByTarga = new Map(vehicles.map((v) => [v.targa.toUpperCase(), v]));
const knownTargas = new Set(vehicleByTarga.keys());

// Servicios por vehiculo (ordenados) para deducir el area de la multa a partir del servicio mas cercano a la infraccion.
const recordsByVehicle = new Map();
for (const r of records) {
  if (!recordsByVehicle.has(r.vehicleId)) recordsByVehicle.set(r.vehicleId, []);
  recordsByVehicle.get(r.vehicleId).push({ at: r.fechaServicio.getTime(), key: recordAreaKey(r) });
}
const areaFor = (vehicle, day) => {
  if (!vehicle) return { area: null, fuente: "sin vehiculo" };
  const list = recordsByVehicle.get(vehicle.id) ?? [];
  if (day && list.length) {
    const t = dayDate(day).getTime();
    let best = null;
    for (const r of list) {
      const d = Math.abs(r.at - t);
      if (d <= 10 * DAY && (!best || d < best.d)) best = { d, key: r.key };
    }
    if (best) return { area: best.key, fuente: "servicio cercano" };
  }
  if (list.length) {
    const counts = new Map();
    for (const r of list) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    return { area: [...counts].sort((a, b) => b[1] - a[1])[0][0], fuente: "area mas usada por el vehiculo" };
  }
  const roma = vehicle.grupo === "ROMA";
  if (vehicle.area === "DHL") return { area: roma ? "dhl-roma" : "dhl-milano", fuente: "area del vehiculo" };
  if (vehicle.area === "EXTRAS_PIAZZA") return { area: roma ? "piazza-roma" : "piazza-milano", fuente: "area del vehiculo" };
  if (vehicle.area === "FARMACIA") return { area: "otros", fuente: "area del vehiculo" };
  return { area: null, fuente: "sin area" };
};

// ---- lectura del CSV y armado de cada multa ---------------------------------------------------------------------------------------------
const csvRows = parseCsv(readFileSync(file, "utf8"));
const today = romeToday();
const isMancato = (tipo) => /MANCATO PAGAMENTO/i.test(tipo);

// Un verbale repetido en el CSV es la MISMA multa cargada dos veces en AppSheet (por ejemplo una copia "no pagada" y otra "pagada"): se
// unen en una sola para no contar deuda que no existe. Manda la mas completa (pagada > con monto > con chofer > la mas reciente) y
// completa sus huecos con la otra; los comentarios de ambas se conservan.
const score = (r) => (fold(r.ESTADO) === "PAGADO" ? 4 : 0) + (r.MONTO ? 2 : 0) + (r.INFRACTOR ? 1 : 0);
const mergeRows = (rows) => {
  const groups = new Map();
  for (const r of rows) {
    const key = r["Nro VERBALE"].trim().toUpperCase() || `__${r.Id_Multas}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const merged = [];
  const fusiones = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    const ordered = [...list].sort((a, b) => score(b) - score(a) || b._linea - a._linea);
    const out = { ...ordered[0] };
    for (const other of ordered.slice(1)) {
      for (const k of Object.keys(out)) {
        if (k === "COMENTARIOS" || k === "_linea") continue;
        if (!out[k] && other[k]) out[k] = other[k];
      }
      if (other.COMENTARIOS && !out.COMENTARIOS.includes(other.COMENTARIOS)) out.COMENTARIOS = [out.COMENTARIOS, other.COMENTARIOS].filter(Boolean).join(" | ");
    }
    out._fusion = list.map((r) => r._linea).sort((a, b) => a - b);
    merged.push(out);
    fusiones.push(out._fusion);
  }
  return { merged: merged.sort((a, b) => a._linea - b._linea), fusiones };
};
const { merged: mergedRows, fusiones } = mergeRows(csvRows);
const numeroFor = (raw) => raw.trim().toUpperCase().slice(0, 60);

const typeOf = (tipoRaw) => tipoRaw.replace(/\s*\(.*$/, "").trim();
const problems = [];
const items = [];

for (const r of mergedRows) {
  const avisos = [];
  const id = r.Id_Multas;
  const numero = numeroFor(r["Nro VERBALE"] || `AS-${id}`);
  if (!r["Nro VERBALE"]) avisos.push("sin numero de verbale");
  if (r._fusion) avisos.push(`repetida en el CSV: se unieron las lineas ${r._fusion.join(" y ")}`);

  const recepcionCsv = dayOf(r["FECHA DE RECEPCIÓN"]);
  const ocrPath = join(OCR_DIR, `${id}.txt`);
  const ocr = existsSync(ocrPath) ? parseVerbale(readFileSync(ocrPath, "utf8"), { knownTargas, recepcionDay: recepcionCsv }) : null;

  // targa: la del CSV; si falta, la del PDF; si no coinciden, manda el PDF (es el documento legal) y se avisa en los comentarios.
  const csvTarga = targaOf(r.TARGA);
  let targa = csvTarga;
  let targaFuente = csvTarga ? "csv" : "";
  let notaTarga = null;
  if (ocr?.targa) {
    if (!csvTarga) {
      targa = ocr.targa;
      targaFuente = "pdf";
    } else if (csvTarga !== ocr.targa) {
      targa = ocr.targa;
      targaFuente = "pdf (el CSV decia otra)";
      notaTarga = `Targa tomada del PDF (${ocr.targa}); en AppSheet figuraba ${csvTarga}.`;
      avisos.push(`targa distinta: csv ${csvTarga} / pdf ${ocr.targa}`);
    }
  }
  if (!targa) {
    targa = "SINTARGA";
    targaFuente = "sin dato";
    avisos.push("sin targa");
  }
  const vehicle = vehicleByTarga.get(targa) ?? null;
  if (targa !== "SINTARGA" && !vehicle) avisos.push(`targa ${targa} no esta en la flota`);

  // fechas
  const vencCsv = dayOf(r["ÚLTIMO DÍA PAGO"]);
  let fechaInfraccion = ocr?.fecha ?? null;
  let hora = fechaInfraccion ? (ocr?.hora ?? null) : null;
  let recepcion = recepcionCsv;
  let recepcionFuente = recepcionCsv ? "csv" : "";
  if (!recepcion && vencCsv) {
    recepcion = addDays(vencCsv, -60);
    recepcionFuente = "ultimo dia de pago - 60 dias";
  }
  // La recepcion estimada nunca puede ser anterior al dia de la infraccion.
  if (!recepcionCsv && fechaInfraccion && (!recepcion || recepcion < fechaInfraccion)) {
    recepcion = fechaInfraccion;
    recepcionFuente = recepcionFuente ? `${recepcionFuente} (ajustada al dia de la infraccion)` : "dia de la infraccion";
  }
  if (!recepcion) {
    problems.push({ r, motivo: "sin ninguna fecha (ni recepcion, ni vencimiento, ni infraccion)" });
    recepcion = today;
    recepcionFuente = "hoy (sin dato)";
  }
  if (fechaInfraccion && fechaInfraccion > recepcion) {
    avisos.push(`el PDF dice infraccion ${fechaInfraccion}, posterior a la recepcion: se descarta`);
    fechaInfraccion = null;
    hora = null;
  }
  if (recepcion > today) recepcion = today;
  let vencimiento = vencCsv && vencCsv >= recepcion ? vencCsv : addDays(recepcion, 60);

  // monto
  let costo = montoOf(r.MONTO);
  let montoFuente = costo ? "csv" : "";
  if (!costo) {
    costo = montoOf(r.SALDO);
    montoFuente = costo ? "saldo" : "";
  }
  if (!costo) {
    costo = 0;
    montoFuente = "sin dato";
    avisos.push("sin monto: completar");
  }

  // chofer
  const infractor = fold(r.INFRACTOR);
  const trabajador = fold(r.Id_trabajador);
  let driver = null;
  let choferFuente = "";
  let empresa = false;
  if (infractor === "EMPRESA") {
    driver = userByName.get(EMPRESA_PROFILE) ?? null;
    empresa = true;
    choferFuente = "EMPRESA (perfil Gamonal Trasporti)";
  } else if (infractor && infractor !== "LIBRE") {
    const p = personFor(r.INFRACTOR);
    if (p === undefined) avisos.push(`infractor sin resolver: ${r.INFRACTOR}`);
    driver = p ?? null;
    choferFuente = "infractor";
  } else if (trabajador && trabajador !== EMPRESA_PROFILE) {
    const p = personFor(r.Id_trabajador);
    if (p === undefined) avisos.push(`trabajador sin resolver: ${r.Id_trabajador}`);
    driver = p ?? null;
    choferFuente = "id_trabajador";
  }
  if (!driver) choferFuente = choferFuente || "sin chofer (se sugerira)";

  // quien paga / pagado / descontado
  const pag = fold(r["¿AUTISTA PAGÓ?"]);
  const pagoFecha = /^\d{1,2} \d{1,2} \d{4}$/.test(pag);
  let quienPaga = "CHOFER_PAGO";
  let descontado = false;
  if (empresa) quienPaga = "CHOFER_PAGO";
  else if (pag.includes("YA PAGO") || pagoFecha) quienPaga = "CHOFER_PAGO";
  else if (pag.includes("DESCONTADO")) {
    quienPaga = "A_DESCONTAR";
    descontado = true;
  } else if (pag.includes("HA DESCONTAR")) quienPaga = "A_DESCONTAR";
  else quienPaga = driver ? "A_DESCONTAR" : "CHOFER_PAGO"; // PENDIENTE o vacio
  const estado = fold(r.ESTADO);
  const pagado = estado === "PAGADO";

  // area
  const { area, fuente: areaFuente } = areaFor(vehicle, fechaInfraccion ?? recepcion);

  // comentarios
  const tipo = typeOf(r.TIPO);
  const lines = [];
  if (isMancato(r.TIPO)) {
    lines.push("Multa que llego por no haber pagado un mancato pagamento (mancato pagamento no pagado).");
    if (fechaInfraccion) lines.push(`Transito en el peaje: ${fechaInfraccion.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}.`);
  } else if (tipo) lines.push(`Tipo (AppSheet): ${tipo}.`);
  if (r.COMENTARIOS) lines.push(r.COMENTARIOS);
  if (notaTarga) lines.push(notaTarga);
  if (ocr?.referencias?.length && !isMancato(r.TIPO)) lines.push(`Verbale al que se refiere (segun el PDF): ${ocr.referencias.join(", ")}.`);
  if (/^(Y|SI)$/i.test(r["PTOS PATENTE"])) lines.push("Descuenta puntos de la licencia.");
  if (r["C. AVVISO"]) lines.push(`Cod. aviso pagoPA: ${r["C. AVVISO"]}.`);
  if (montoFuente === "sin dato") lines.push("El monto no figuraba en AppSheet (multa ya pagada): completar si hace falta.");
  if (estado === "VERIFICACION EMAIL") lines.push("En AppSheet figuraba como 'Verificación email'.");
  if (recepcionFuente && recepcionFuente !== "csv") lines.push(`Fecha de recepcion estimada (${recepcionFuente}).`);
  const comentarios = lines.join("\n").slice(0, 1000) || null;

  // archivo
  const pdfPath = join(PDF_DIR, `${id}.bin`);
  let adjunto = "no";
  if (existsSync(pdfPath)) {
    const head = readFileSync(pdfPath).subarray(0, 4);
    adjunto = head.toString("latin1") === "%PDF" ? "pdf" : head[0] === 0xff && head[1] === 0xd8 ? "foto" : "invalido";
  }
  if (adjunto === "no" || adjunto === "invalido") avisos.push("sin archivo (no se pudo bajar)");

  items.push({
    linea: r._linea, id, numero, tipo, targa, targaFuente, vehicle, driver, choferFuente, fechaInfraccion, hora,
    recepcion, recepcionFuente, vencimiento, costo, montoFuente, estado, pagado, quienPaga, descontado, area, areaFuente, comentarios, adjunto,
    pdfPath, avisos, yaEsta: existingNumbers.has(numero),
  });
}

// ---- informe ---------------------------------------------------------------------------------------------------------------------------
const count = (list, fn) => list.reduce((m, i) => m.set(fn(i), (m.get(fn(i)) ?? 0) + 1), new Map());
const show = (title, map) => console.log(`${title}: ${[...map].map(([k, v]) => `${k || "-"} ${v}`).join(" | ")}`);
const nuevos = items.filter((i) => !i.yaEsta);
console.log(`\nCSV: ${csvRows.length} filas (${fusiones.length} verbales repetidos unidos) | ya en la base: ${items.length - nuevos.length} | a subir: ${nuevos.length}`);
show("Targa", count(nuevos, (i) => i.targaFuente));
show("Chofer", count(nuevos, (i) => i.choferFuente));
show("Fecha de recepcion", count(nuevos, (i) => i.recepcionFuente));
show("Monto", count(nuevos, (i) => i.montoFuente));
show("Archivo", count(nuevos, (i) => i.adjunto));
show("Area", count(nuevos, (i) => `${i.area ?? "sin area"} (${i.areaFuente})`));
show("Quien paga", count(nuevos, (i) => `${i.quienPaga}${i.descontado ? "+descontado" : ""}`));
console.log(`Con dia de infraccion: ${nuevos.filter((i) => i.fechaInfraccion).length} (con hora ${nuevos.filter((i) => i.hora).length})`);
console.log(`Pagadas: ${nuevos.filter((i) => i.pagado).length} | sin pagar: ${nuevos.filter((i) => !i.pagado).length}`);
console.log(`Choferes a crear (inactivos): ${[...newUsers.values()].map((u) => `${u.nombre} ${u.apellido}`).join(", ") || "-"}`);
const sinResolver = nuevos.flatMap((i) => i.avisos.filter((a) => /sin resolver/.test(a)));
if (sinResolver.length) console.log(`SIN RESOLVER: ${[...new Set(sinResolver)].join(" | ")}`);
if (problems.length) console.log(`PROBLEMAS: ${problems.length} filas sin ninguna fecha (se cargan con la de hoy): ${problems.map((p) => p.r._linea).join(", ")}`);

const reportPath = join(OUT_DIR, "multas-appsheet-informe.csv");
writeFileSync(
  reportPath,
  [
    ["linea", "id", "verbale", "tipo", "targa", "fuente_targa", "chofer", "fuente_chofer", "dia_infraccion", "hora", "recepcion", "fuente_recepcion", "vencimiento", "monto", "fuente_monto", "estado", "quien_paga", "area", "archivo", "avisos", "ya_en_base"],
    ...items.map((i) => [
      i.linea, i.id, i.numero, i.tipo, i.targa, i.targaFuente, i.driver ? `${i.driver.nombre} ${i.driver.apellido}` : "", i.choferFuente, i.fechaInfraccion ?? "",
      i.hora ?? "", i.recepcion, i.recepcionFuente, i.vencimiento, i.costo, i.montoFuente, i.estado, `${i.quienPaga}${i.descontado ? "+descontado" : ""}`,
      i.area ?? "", i.adjunto, i.avisos.join("; "), i.yaEsta ? "si" : "",
    ]),
  ].map((row) => row.map(csvEscape).join(";")).join("\n"),
);
console.log(`\nInforme: ${reportPath}`);

if (!APPLY) {
  console.log("Modo prueba: no se escribio nada. Para subir, agrega --aplicar.");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- subir ---------------------------------------------------------------------------------------------------------------------------
const undoPath = join(OUT_DIR, `multas-appsheet-deshacer-${STAMP}.json`);
const undo = { multaIds: [], keys: [], userIds: [] };
const saveUndo = () => writeFileSync(undoPath, JSON.stringify(undo));

for (const [key, u] of newUsers) {
  if (!nuevos.some((i) => i.driver?.id === u.id)) continue;
  let email = `${u.nombre}.${u.apellido}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".") + "@importado-appsheet.invalid";
  for (let n = 2; existingEmails.has(email); n += 1) email = `${u.nombre}.${u.apellido}.${n}`.toLowerCase().replace(/\s+/g, ".") + "@importado-appsheet.invalid";
  existingEmails.add(email);
  await prisma.user.create({
    data: {
      id: u.id,
      nombre: u.nombre,
      apellido: u.apellido,
      area: "DHL",
      cargo: "CHOFER",
      estado: "INACTIVO",
      fechaNacimiento: new Date("1900-01-01T00:00:00.000Z"),
      numeroCelular: "Sin dato",
      correoElectronico: email,
      password: await hashPassword(randomUUID()),
    },
  });
  undo.userIds.push(u.id);
  console.log(`Chofer creado: ${u.nombre} ${u.apellido} (inactivo, sin acceso)`);
  void key;
}
saveUndo();

const uploadFile = async (item) => {
  const buf = readFileSync(item.pdfPath);
  if (item.adjunto === "pdf") {
    const key = `multas/${item.id}/multa-${Date.now()}-${randomUUID()}.pdf`;
    await uploadObject(key, buf, "application/pdf");
    return key;
  }
  const key = `multas/${item.id}/multa-${Date.now()}-${randomUUID()}.webp`;
  await uploadObject(key, await compressImage(buf), "image/webp");
  return key;
};

let done = 0;
let failed = 0;
const queue = nuevos.filter((i) => !i.yaEsta);
const worker = async () => {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    let key = null;
    try {
      const multaId = randomUUID();
      item.multaId = multaId;
      if (item.adjunto === "pdf" || item.adjunto === "foto") {
        key = await uploadFile({ ...item, id: multaId });
        undo.keys.push(key);
      }
      await prisma.multa.create({
        data: {
          id: multaId,
          numeroVerbale: item.numero,
          targa: item.targa,
          vehicleId: item.vehicle?.id ?? null,
          driverId: item.driver?.id ?? null,
          fechaInfraccion: item.fechaInfraccion ? dayDate(item.fechaInfraccion) : null,
          horaInfraccion: item.hora,
          fechaRecepcion: dayDate(item.recepcion),
          fechaVencimiento: dayDate(item.vencimiento),
          costo: item.costo,
          quienPaga: item.quienPaga,
          descontado: item.descontado,
          descontadoAt: item.descontado ? romeLocalToDate(item.recepcion, "12:00") : null,
          comentarios: item.comentarios,
          multaKey: key,
          area: item.area,
          pagado: item.pagado,
          // No se sabe cuando se pago: se usa el dia de recepcion para que no figure como pagada fuera de plazo.
          pagadoAt: item.pagado ? romeLocalToDate(item.recepcion, "12:00") : null,
          // La historia (deuda abierta mes a mes) cuenta desde que llego la multa, no desde que se importo.
          createdAt: romeLocalToDate(item.recepcion, "12:00"),
        },
      });
      undo.multaIds.push(multaId);
      done += 1;
      if (done % 25 === 0) {
        saveUndo();
        console.log(`  ${done}/${nuevos.length} multas subidas...`);
      }
    } catch (err) {
      failed += 1;
      if (key) {
        await deleteObject(key).catch(() => {});
        undo.keys = undo.keys.filter((k) => k !== key);
      }
      console.error(`Fallo ${item.numero} (linea ${item.linea}): ${err.message.split("\n").at(-1)}`);
    }
  }
};
await Promise.all([worker(), worker(), worker(), worker()]);
saveUndo();
console.log(`\nSubidas ${done} multas${failed ? `, ${failed} con error (se puede volver a correr: no repite las que ya estan)` : ""}.`);
console.log(`Para deshacer: node scripts/import-multas-appsheet.mjs --revertir ${undoPath}`);
await prisma.$disconnect();
