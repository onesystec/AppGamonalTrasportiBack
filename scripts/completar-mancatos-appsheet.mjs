// Completa los mancatos que subio import-mancatos-appsheet.mjs: crea los choferes y los vehiculos del CSV que no existian en la app y los
// vincula a sus mancatos (solo donde el mancato no tenia chofer o vehiculo). Despues vuelve a asignar a su servicio los que quedaron con
// vehiculo nuevo (solo desde el 1 de julio de 2026: los anteriores no se asignan).
//
//   node scripts/completar-mancatos-appsheet.mjs <archivo.csv>             -> informe SIN escribir nada
//   node scripts/completar-mancatos-appsheet.mjs <archivo.csv> --aplicar   -> crea y vincula
//
// Los choferes nuevos se crean INACTIVOS (sin acceso: la clave es aleatoria y no se muestra) con datos de relleno que la oficina puede
// completar; los vehiculos nuevos quedan con area "Sin asignar" y modelo "Por completar", igual que los que trae Velocity Fleet.
// Los de "GAMONAL TRASPORTI" (la empresa) y los que no traen nombre se asignan a un perfil de la empresa (Gamonal Trasporti, tambien
// inactivo). No se crean vehiculos para targas que no tienen formato italiano (AA123BB): esos mancatos quedan con targa "SIN TARGA".
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { prisma } from "../src/config/prisma.js";
import { matchMancato } from "../src/services/mancatoMatching.service.js";
import { hashPassword } from "../src/utils/password.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const file = args.find((a) => !a.startsWith("--"));

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

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const targaOf = (s) => s.replace(/\s+/g, "").toUpperCase();

// Mismo criterio que el importador para reconocer el numero del aviso.
const cleanNumero = (raw) => {
  const n = raw.replace(/^[‘’'"`\s]+/, "").replace(/[-\s]+$/, "").toUpperCase();
  if (/^\d{8,12}$/.test(n)) return n;
  if (/^\d{8,12}-\d{1,2}$/.test(n)) return n;
  if (/^\d{3,8}\/\d{4}$/.test(n)) return n;
  if (/^[0-9A-Z]{8,16}$/.test(n) && (n.match(/\d/g) ?? []).length >= 6) return n;
  return null;
};

// Igual de tolerante que el importador con una letra de error en el apellido.
const edit1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};
const sameName = (a, b) => {
  if (a === b) return true;
  const [fa, ...ra] = a.split(" ");
  const [fb, ...rb] = b.split(" ");
  return fa === fb && ra.length > 0 && rb.length > 0 && edit1(ra.at(-1), rb.at(-1));
};

const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const splitName = (full) => {
  const parts = full.split(" ");
  if (parts.length <= 2) return { nombre: titleCase(parts[0]), apellido: titleCase(parts.slice(1).join(" ") || "-") };
  // "JEAN PAUL SOSA" / "JUAN CARLOS LAZARO": el ultimo es el apellido.
  return { nombre: titleCase(parts.slice(0, -1).join(" ")), apellido: titleCase(parts.at(-1)) };
};
const slug = (s) => s.toLowerCase().replace(/\s+/g, ".");

if (!file || !existsSync(file)) {
  console.error("Uso: node scripts/completar-mancatos-appsheet.mjs <archivo.csv> [--aplicar]");
  process.exit(1);
}

const csv = parseCsv(readFileSync(file, "utf8"));
const rowByNumero = new Map();
for (const row of csv) {
  const numero = cleanNumero(row["VERBALE O SOLLECITO"]);
  if (numero && !rowByNumero.has(numero)) rowByNumero.set(numero, row);
}

const [users, vehicles, mancatos] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, correoElectronico: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true } }),
  prisma.mancatoPagamento.findMany({
    where: { OR: [{ driverId: null }, { vehicleId: null }] },
    select: { id: true, numero: true, driverId: true, vehicleId: true, fecha: true, fechaHoraTransito: true, asignacion: true, recordId: true },
  }),
]);

// ---- choferes ---------------------------------------------------------------------------------------------------------------------------
const userNames = users.map((u) => ({ id: u.id, full: fold(`${u.nombre} ${u.apellido}`) }));
const existingEmails = new Set(users.map((u) => u.correoElectronico.toLowerCase()));
const findDriver = (full) => userNames.find((u) => sameName(u.full, full))?.id ?? null;

const newDrivers = new Map(); // nombre normalizado -> { full, numeros: [], id }
const driverLinks = new Map(); // driverId -> numeros
const vehicleByTarga = new Map(vehicles.map((v) => [targaOf(v.targa), v.id]));
const newVehicles = new Map(); // targa -> { numeros: [], id }
const vehicleLinks = new Map(); // vehicleId -> numeros
const skippedTargas = new Map();
const relinked = []; // mancatos con vehiculo nuevo (para volver a asignarlos)

const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);

for (const m of mancatos) {
  const row = rowByNumero.get(m.numero);
  if (!row) continue;

  if (!m.driverId) {
    // Sin nombre o "GAMONAL TRASPORTI": el mancato es de la empresa.
    const full = fold(row["ID_ TRABAJADOR"]) || "GAMONAL TRASPORTI";
    {
      const known = findDriver(full);
      if (known) push(driverLinks, known, m.numero);
      else {
        // Una letra de diferencia con un chofer que ya vamos a crear es el mismo.
        const same = [...newDrivers.keys()].find((k) => sameName(k, full));
        const key = same ?? full;
        if (!newDrivers.has(key)) newDrivers.set(key, { full: key, numeros: [], id: randomUUID() });
        newDrivers.get(key).numeros.push(m.numero);
      }
    }
  }

  if (!m.vehicleId) {
    const targa = targaOf(row.TARGA);
    if (!/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(targa)) {
      skippedTargas.set(targa || "(sin targa)", (skippedTargas.get(targa || "(sin targa)") ?? 0) + 1);
    } else if (vehicleByTarga.has(targa)) {
      push(vehicleLinks, vehicleByTarga.get(targa), m.numero);
      relinked.push({ ...m, vehicleId: vehicleByTarga.get(targa) });
    } else {
      if (!newVehicles.has(targa)) newVehicles.set(targa, { numeros: [], id: randomUUID(), items: [] });
      newVehicles.get(targa).numeros.push(m.numero);
      newVehicles.get(targa).items.push(m);
    }
  }
}

const ASIGNAR_DESDE = new Date("2026-07-01T00:00:00.000Z");
const reassignable = (m) => m.fechaHoraTransito && m.fecha >= ASIGNAR_DESDE && !m.recordId && m.asignacion === "EN_ESPERA";

console.log(`Mancatos sin chofer o sin vehiculo en la app: ${mancatos.length} (${[...rowByNumero.keys()].length} numeros en el CSV)`);
console.log("\nChoferes que ya existen y se vinculan:", [...driverLinks].map(([id, n]) => `${userNames.find((u) => u.id === id).full} (${n.length})`).join(", ") || "ninguno");
console.log("\nChoferes a CREAR (inactivos, sin acceso):");
[...newDrivers.values()].sort((a, b) => b.numeros.length - a.numeros.length).forEach((d) => console.log(`  ${d.full}  ->  ${d.numeros.length} mancatos`));
console.log("\nVehiculos existentes que se vinculan:", [...vehicleLinks].map(([id, n]) => `${vehicles.find((v) => v.id === id).targa} (${n.length})`).join(", ") || "ninguno");
console.log("\nVehiculos a CREAR (area Sin asignar):");
[...newVehicles].sort((a, b) => b[1].numeros.length - a[1].numeros.length).forEach(([t, v]) => console.log(`  ${t}  ->  ${v.numeros.length} mancatos`));
console.log("\nTargas sin formato italiano (no se crea):", [...skippedTargas].map(([k, n]) => `${k} (${n})`).join(", ") || "ninguna");

const toReassign = [...relinked, ...[...newVehicles.values()].flatMap((v) => v.items.map((m) => ({ ...m, vehicleId: v.id })))].filter(reassignable);
console.log(`\nMancatos con vehiculo nuevo que se vuelven a asignar a un servicio (desde el 1/7/2026, con hora): ${toReassign.length}`);

if (!APPLY) {
  console.log("\n(Informe: no se escribio nada. Usa --aplicar para crear y vincular.)");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- aplicar ----------------------------------------------------------------------------------------------------------------------------
for (const d of newDrivers.values()) {
  const { nombre, apellido } = splitName(d.full);
  let email = `${slug(d.full)}@importado-appsheet.invalid`;
  for (let n = 2; existingEmails.has(email); n += 1) email = `${slug(d.full)}.${n}@importado-appsheet.invalid`;
  existingEmails.add(email);
  await prisma.user.create({
    data: {
      id: d.id,
      nombre,
      apellido,
      area: "DHL",
      cargo: "CHOFER",
      estado: "INACTIVO",
      fechaNacimiento: new Date("1900-01-01T00:00:00.000Z"),
      numeroCelular: "Sin dato",
      correoElectronico: email,
      password: await hashPassword(randomUUID()),
    },
  });
  driverLinks.set(d.id, d.numeros);
}
if (newVehicles.size > 0) {
  await prisma.vehiculo.createMany({
    data: [...newVehicles].map(([targa, v]) => ({ id: v.id, targa, modelo: "Por completar", area: "SIN_ASIGNAR", estado: "DISPONIBLE" })),
    skipDuplicates: true,
  });
  for (const [, v] of newVehicles) vehicleLinks.set(v.id, v.numeros);
}

let linkedDrivers = 0;
for (const [driverId, numeros] of driverLinks) {
  linkedDrivers += (await prisma.mancatoPagamento.updateMany({ where: { numero: { in: numeros }, driverId: null }, data: { driverId } })).count;
}
let linkedVehicles = 0;
for (const [vehicleId, numeros] of vehicleLinks) {
  linkedVehicles += (await prisma.mancatoPagamento.updateMany({ where: { numero: { in: numeros }, vehicleId: null }, data: { vehicleId } })).count;
}
console.log(`\nCreados ${newDrivers.size} choferes y ${newVehicles.size} vehiculos. Vinculados: ${linkedDrivers} a un chofer, ${linkedVehicles} a un vehiculo.`);

const driverByNumero = new Map([...driverLinks].flatMap(([driverId, numeros]) => numeros.map((n) => [n, driverId])));
let assigned = 0;
for (const m of toReassign) {
  const next = await matchMancato({ vehicleId: m.vehicleId, driverId: m.driverId ?? driverByNumero.get(m.numero) ?? null, fechaHoraTransito: m.fechaHoraTransito });
  if (next.recordId) {
    await prisma.mancatoPagamento.update({ where: { id: m.id }, data: next });
    assigned += 1;
  }
}
console.log(`Asignados a un servicio: ${assigned} de ${toReassign.length}.`);
await prisma.$disconnect();
