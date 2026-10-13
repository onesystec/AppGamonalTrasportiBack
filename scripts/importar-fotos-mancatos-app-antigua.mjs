// Sube las fotos y recibos de los mancatos que trajo import-mancatos-app-antigua.mjs. Las imagenes estan en el S3 de la app antigua (URLs del
// CSV: "URL Foto 1", "URL Foto 2", "URL Recibo"); se descargan, se comprimen a webp (igual que al subirlas desde la app) y se guardan en el
// bucket de la app. Foto 1 -> foto del mancato, Recibo -> comprobante. Foto 2 no tiene lugar en la ficha: solo se usa si no hay Foto 1.
//
//   node scripts/importar-fotos-mancatos-app-antigua.mjs <archivo.csv> <numeros.txt>              -> informe, sin descargar ni escribir
//   node scripts/importar-fotos-mancatos-app-antigua.mjs <archivo.csv> <numeros.txt> --aplicar    -> descarga y sube
//
// <numeros.txt> es la lista que dejo el importador (solo se tocan esos mancatos). Se puede repetir: los que ya tienen foto se saltan.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { prisma } from "../src/config/prisma.js";
import { uploadObject } from "../src/services/storage.service.js";
import { compressImage } from "../src/utils/imageProcessor.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const [csvFile, listFile] = args.filter((a) => !a.startsWith("--"));
if (!csvFile || !listFile) {
  console.error("Uso: node scripts/importar-fotos-mancatos-app-antigua.mjs <archivo.csv> <numeros.txt> [--aplicar]");
  process.exit(1);
}

const ORIGEN = "https://nexara-s3.s3.us-east-1.amazonaws.com/logistica/";
const MAX_BYTES = 20 * 1024 * 1024;

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
  return body.map((r) => Object.fromEntries(names.map((n, k) => [n, (r[k] ?? "").trim()])));
};

// Mismo criterio de numero que el importador.
const cleanNumero = (raw) => {
  const n = raw.replace(/^[‘’'"`\s]+/, "").replace(/[-\s]+$/, "").toUpperCase();
  if (/^\d{8,12}$/.test(n)) return n;
  if (/^\d{8,12}-\d{1,2}$/.test(n)) return n;
  if (/^\d{3,8}\/\d{4}$/.test(n)) return n;
  if (/^[0-9A-Z]{8,16}$/.test(n) && (n.match(/\d/g) ?? []).length >= 6) return n;
  return null;
};

const allowed = new Set(readFileSync(listFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
const wanted = new Map(); // numero -> { foto, comprobante }
for (const row of parseCsv(readFileSync(csvFile, "utf8"))) {
  const numero = cleanNumero(row["Nº Mancato"]) ?? `SIN-NUMERO-AA-${row.Linea}`;
  if (!allowed.has(numero) || wanted.has(numero)) continue;
  const foto = row["URL Foto 1"] || row["URL Foto 2"] || null;
  const comprobante = row["URL Recibo"] || null;
  if (foto || comprobante) wanted.set(numero, { foto, comprobante });
}

const mancatos = await prisma.mancatoPagamento.findMany({
  where: { numero: { in: [...wanted.keys()] } },
  select: { id: true, numero: true, fotoKey: true, comprobanteKey: true },
});
const jobs = [];
for (const m of mancatos) {
  const w = wanted.get(m.numero);
  if (w.foto && !m.fotoKey) jobs.push({ m, kind: "foto", url: w.foto });
  if (w.comprobante && !m.comprobanteKey) jobs.push({ m, kind: "comprobante", url: w.comprobante });
}
console.log(`Mancatos con imagen en el CSV: ${wanted.size} · encontrados en la app: ${mancatos.length} · imagenes a subir: ${jobs.length} (fotos ${jobs.filter((j) => j.kind === "foto").length}, recibos ${jobs.filter((j) => j.kind === "comprobante").length})`);
const fuera = jobs.filter((j) => !j.url.startsWith(ORIGEN));
if (fuera.length) {
  console.log(`AVISO: ${fuera.length} URLs no son del S3 de la app antigua y se saltan.`);
  fuera.forEach((j) => jobs.splice(jobs.indexOf(j), 1));
}
if (!APPLY) {
  console.log("\n(Informe: no se descargo ni se escribio nada. Para subir: agrega --aplicar)");
  await prisma.$disconnect();
  process.exit(0);
}

let ok = 0;
const fallos = [];
let bytesIn = 0;
let bytesOut = 0;
const run = async (job) => {
  try {
    const res = await fetch(job.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/^image\//.test(type)) throw new Error(`no es imagen (${type})`);
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length > MAX_BYTES) throw new Error(`pesa ${raw.length} bytes`);
    const buffer = await compressImage(raw);
    const key = `mancato/${job.m.id}/${job.kind}-${Date.now()}-${randomUUID()}.webp`;
    await uploadObject(key, buffer, "image/webp");
    await prisma.mancatoPagamento.update({ where: { id: job.m.id }, data: job.kind === "foto" ? { fotoKey: key } : { comprobanteKey: key } });
    bytesIn += raw.length;
    bytesOut += buffer.length;
    ok += 1;
  } catch (err) {
    fallos.push({ numero: job.m.numero, kind: job.kind, error: err.message });
  }
};

const queue = [...jobs];
await Promise.all(
  Array.from({ length: 5 }, async () => {
    while (queue.length) {
      await run(queue.shift());
      if (ok % 50 === 0 && ok > 0) console.log(`  ... ${ok}/${jobs.length}`);
    }
  })
);
console.log(`\nSubidas ${ok} de ${jobs.length} imagenes (${(bytesIn / 1e6).toFixed(1)} MB originales -> ${(bytesOut / 1e6).toFixed(1)} MB).`);
if (fallos.length) console.log("Fallaron:", fallos);
await prisma.$disconnect();
