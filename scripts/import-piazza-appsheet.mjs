// Sube a la app los servicios de Extra Piazza exportados de AppSheet (CSV con ";") que todavia no estan. Es solo pasar informacion: escribe directo
// en la base, no recalcula rutas, no reasigna peajes ni combustible y no manda avisos.
//
//   node scripts/import-piazza-appsheet.mjs <archivo.csv>               -> informe SIN escribir nada
//   node scripts/import-piazza-appsheet.mjs <archivo.csv> --aplicar     -> sube
//   node scripts/import-piazza-appsheet.mjs --revertir <deshacer.json>  -> borra lo que subio esa corrida
//
// Cada servicio de la base se usa una sola vez: se empareja por codigo + km + dia, luego codigo + km, y por ultimo dia + km + cliente. Lo que
// no tiene pareja se sube con zona Milano; el codigo sale de la columna CODIGO o, si no, del texto de la descripcion (S2060xxxx / 26WCIMXPxxxx).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { ESTADO_MAP, fromRomeParts } from "../src/constants/appsheetMaps.js";
import { hashPassword } from "../src/utils/password.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const REVERT = args.includes("--revertir");
const file = args.find((a) => !a.startsWith("--"));
const OUT_DIR = join(homedir(), "Downloads");

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

// ---- normalizaciones --------------------------------------------------------------------------------------------------------------
const fold = (s) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const foldKey = (s) => fold(s).replace(/ /g, "");
const targaOf = (s) => (s ?? "").split(" - ")[0].replace(/\s+/g, "").toUpperCase();
const romeDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const dayOf = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec((s ?? "").trim());
  return m ? { y: Number(m[3]), mo: Number(m[2]), d: Number(m[1]), key: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` } : null;
};
const numberOf = (raw) => {
  const cleaned = String(raw ?? "").replace("€", "").replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const v = Number(cleaned);
  return Number.isNaN(v) ? null : v;
};
const kmKey = (v) => Math.round(Number(v) || 0);
const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

// ---- choferes: columna AUTISTA + lo que dice el comentario -----------------------------------------------------------------------
// Alias que escribe la oficina en el comentario -> chofer del sistema (nombre completo normalizado). Los pidio el usuario.
const ALIAS = [
  [/\b(kevin( mera)?|kevim|keniv)\b/, "KEVIN MERA"],
  [/\bjose( guizado| rojas)?\b/, "JOSE GUIZADO"],
  [/\b(eduar|eduard|edward)\b/, "EDUAR FARMACIA"],
  [/\bantony\b/, "KEVIN FERNANDEZ"],
  [/\b(dany( aranda)?|daniel|dani)\b/, "DANY ARANDA"],
  [/\bcarlos (rojas|roma)\b/, "CARLOS ROJAS"],
  [/\bmiguel\b/, "MIGUEL SILVA"],
  [/\bmaicol\b/, "MICHAEL AGUILAR"],
  [/\bjhoshua gonzales\b/, "JHOSHUA GONZALES"],
  [/\bgustabo munos\b/, "GUSTAVO MUNOS"],
  [/\bmarvin\b/, "MARVIN CASTILLO"],
  // Nombres de pila que solo coinciden con un chofer del sistema.
  [/\bmoises\b/, "MOISES CHAVEZ"],
  [/\bfabrizio\b/, "FABRIZIO ANCULLE"],
  [/\borlando\b/, "ORLANDO SICCHA"],
  [/\bgustavo\b/, "GUSTAVO VALDERA"],
];
// "lo iso X", "lo hizo X", "lo hace X", "hecho por X", "lo entrego X"... (con las faltas de ortografia que hay).
const VERBO = /\b(iso|isom|ise|hizo|hace|ara|sio|ieso|entrego|hecho por)\b/;
// Cambios de manos, compactados y avances parciales: no cambian al chofer del servicio.
const NO_CAMBIA = /paco|\bdio\b|avans|abans|compact|conpact|afian|recogi|retir|junto al otro/;
const AUTISTA_ALIAS = { "MAURO AGOSTINELLLI": "MAURO AGOSTINELLI", "YAN GAMONAL": "YAN GLAUBER GAMONAL", "": "GAMONAL TRASPORTI" };

// Chofer que dice el comentario, o null si no dice ninguno claro. `motivo` explica por que se descarto (para el informe).
const driverFromNota = (nota) => {
  const n = fold(nota).toLowerCase();
  if (!n) return { name: null };
  const onlyJose = n === "jose rojas";
  if (!onlyJose && !VERBO.test(n)) return { name: null };
  if (NO_CAMBIA.test(n)) return { name: null };
  const found = [...new Set(ALIAS.filter(([rx]) => rx.test(n)).map(([, name]) => name))];
  if (found.length === 1) return { name: found[0] };
  if (found.length > 1) return { name: null, motivo: `nombra a varios (${found.join(", ")})` };
  const despues = n.split(VERBO).pop().trim().split(" ").slice(0, 3).join(" ");
  return { name: null, motivo: `nombre sin reconocer: "${despues}"` };
};


// ---- cruce con la base --------------------------------------------------------------------------------------------------------------
const CODE_RX = /\b(S\d{8}|26WCIMXP\d{7,8})\b/i;
const codeOf = (r) => (r["CÓDIGO"] || CODE_RX.exec(r["DATOS CONSEGNA"])?.[1] || `AP1011-${r._linea}`).toUpperCase();
const LEVELS = [
  ["codigo+km+dia", (r) => [foldKey(r["CÓDIGO"]), kmKey(numberOf(r.KM)), dayOf(r.DATA)?.key], (d) => [foldKey(d.codigo), kmKey(d.kilometros), romeDay(d.fechaServicio)], (r) => Boolean(r["CÓDIGO"])],
  ["codigo+km", (r) => [foldKey(r["CÓDIGO"]), kmKey(numberOf(r.KM))], (d) => [foldKey(d.codigo), kmKey(d.kilometros)], (r) => Boolean(r["CÓDIGO"])],
  // Los subidos por este script: codigo sacado de la descripcion (con letra final si se repetia) o AP1011-<linea>.
  ["codigo-descripcion+dia", (r) => [foldKey(codeOf(r)), dayOf(r.DATA)?.key], (d) => [foldKey(d.codigo.replace(/-[A-Z]$/, "")), romeDay(d.fechaServicio)], (r) => Boolean(codeOf(r))],
  ["dia+km+cliente", (r) => [dayOf(r.DATA)?.key, kmKey(numberOf(r.KM)), foldKey(r.CLIENTE)], (d) => [romeDay(d.fechaServicio), kmKey(d.kilometros), foldKey(d.client.nombre)], () => true],
];
const pairUp = (csvRows, dbRows) => {
  let pendCsv = csvRows.slice();
  let pendDb = dbRows.slice();
  let pares = 0;
  for (const [, fc, fd, ok] of LEVELS) {
    const idx = new Map();
    for (const d of pendDb) {
      const k = fd(d).join("|");
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(d);
    }
    const used = new Set();
    const next = [];
    for (const r of pendCsv) {
      const arr = ok(r) ? idx.get(fc(r).join("|")) : null;
      if (arr?.length) {
        used.add(arr.shift().id);
        pares += 1;
      } else next.push(r);
    }
    pendDb = pendDb.filter((d) => !used.has(d.id));
    pendCsv = next;
  }
  return { pares, nuevos: pendCsv, soloBase: pendDb };
};

if (REVERT) {
  if (!file || !existsSync(file)) {
    console.error("Uso: node scripts/import-piazza-appsheet.mjs --revertir <deshacer.json>");
    process.exit(1);
  }
  const undo = JSON.parse(readFileSync(file, "utf8"));
  const del = await prisma.record.deleteMany({ where: { id: { in: undo.insertados } } });
  console.log(`Borrados ${del.count} servicios. Los choferes, vehiculos y clientes creados se dejan.`);
  await prisma.$disconnect();
  process.exit(0);
}
if (!file || !existsSync(file)) {
  console.error("Uso: node scripts/import-piazza-appsheet.mjs <archivo.csv> [--aplicar]");
  process.exit(1);
}

const csv = parseCsv(readFileSync(file, "utf8")).filter((r) => dayOf(r.DATA)?.y === 2026);
console.log(`CSV: ${csv.length} servicios de 2026.`);

const [users, vehicles, clients, dbRecords, codigos] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, correoElectronico: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true } }),
  prisma.client.findMany({ select: { id: true, nombre: true } }),
  prisma.record.findMany({
    where: { fechaServicio: { gte: new Date("2025-12-25T00:00:00.000Z") }, OR: [{ spedizzione: null }, { spedizzione: "EXTRA_PIAZZA" }] },
    select: { id: true, codigo: true, fechaServicio: true, kilometros: true, client: { select: { nombre: true } } },
  }),
  prisma.record.findMany({ select: { codigo: true } }),
]);
const { pares, nuevos, soloBase } = pairUp(csv, dbRecords);
console.log(`Ya estan en el sistema: ${pares}. Faltan: ${nuevos.length}. En el sistema y no en el CSV (no se tocan): ${soloBase.length}.`);

const userByName = new Map(users.map((u) => [fold(`${u.nombre} ${u.apellido}`), u]));
const existingEmails = new Set(users.map((u) => u.correoElectronico.toLowerCase()));
const newUsers = new Map();
const driverFor = (fullFold, original) => {
  if (userByName.has(fullFold)) return userByName.get(fullFold);
  if (!fullFold) return null;
  if (!newUsers.has(fullFold)) {
    const parts = original.trim().split(/\s+/);
    const apellido = parts.length > 1 ? parts.at(-1) : "-";
    const nombre = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
    newUsers.set(fullFold, { id: randomUUID(), nombre: titleCase(nombre), apellido: titleCase(apellido) });
  }
  return newUsers.get(fullFold);
};
const resolveDriver = (r) => {
  const key = fold(r.AUTISTA);
  const base = driverFor(AUTISTA_ALIAS[key] ?? key, r.AUTISTA);
  const nota = driverFromNota(r.NOTAS);
  const real = nota.name ? userByName.get(nota.name) : null;
  return real ?? base;
};

const vehicleByTarga = new Map(vehicles.map((v) => [foldKey(v.targa), v.id]));
const newVehicles = new Map();
const vehicleIdFor = (r) => {
  const targa = targaOf(r.TARGA);
  if (!targa) return vehicleByTarga.get(foldKey("NOLEGGIO/OTRO")) ?? null;
  const known = vehicleByTarga.get(foldKey(targa));
  if (known) return known;
  if (!/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(targa)) return null;
  if (!newVehicles.has(targa)) newVehicles.set(targa, randomUUID());
  return newVehicles.get(targa);
};

const clientByName = new Map(clients.map((c) => [c.nombre.trim().toLowerCase(), c.id]));
const newClients = new Map();
const clientIdFor = (r) => {
  const nombre = r.CLIENTE.trim() || "Extra piazza";
  const key = nombre.toLowerCase();
  if (clientByName.has(key)) return clientByName.get(key);
  if (!newClients.has(key)) newClients.set(key, { id: randomUUID(), nombre });
  return newClients.get(key).id;
};

const takenCodes = new Set(codigos.map((c) => c.codigo.toUpperCase()));
const codigoFor = (r) => {
  const base = codeOf(r);
  let code = base;
  for (let n = 66; takenCodes.has(code); n += 1) code = `${base}-${String.fromCharCode(n)}`;
  takenCodes.add(code);
  return code;
};

const problemas = [];
const rows = [];
const stops = [];
for (const r of nuevos.sort((a, b) => dayOf(a.DATA).key.localeCompare(dayOf(b.DATA).key) || a._linea - b._linea)) {
  const estado = ESTADO_MAP[r.ESTADO.toUpperCase()];
  if (!estado) {
    problemas.push(`linea ${r._linea}: estado no reconocido "${r.ESTADO}"`);
    continue;
  }
  const driver = resolveDriver(r);
  const vehicleId = vehicleIdFor(r);
  if (!driver || !vehicleId) {
    problemas.push(`linea ${r._linea}: ${!driver ? `sin chofer "${r.AUTISTA}"` : `targa no valida "${r.TARGA}"`}`);
    continue;
  }
  const day = dayOf(r.DATA);
  const fechaServicio = new Date(Date.UTC(day.y, day.mo - 1, day.d));
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(r.ETA);
  const eta = m ? fromRomeParts(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5])) : fechaServicio;
  const ciudad = r.CIUDAD.trim();
  const calle = r.DESTINAZIONE.trim();
  const stop = calle ? (ciudad && !calle.toLowerCase().includes(ciudad.toLowerCase()) ? `${calle}, ${ciudad}` : calle) : ciudad;
  const notas = [r.NOTAS, r.ATTESA && r.ATTESA !== "00:00" ? `Espera: ${r.ATTESA}` : ""].filter(Boolean);
  const id = randomUUID();
  rows.push({
    id,
    estado,
    driverId: driver.id,
    vehicleId,
    clientId: clientIdFor(r),
    fechaServicio,
    eta,
    descripcion: r["DATOS CONSEGNA"] || `${r.CLIENTE || "Extra piazza"} - ${ciudad}`,
    codigo: codigoFor(r),
    destinazione: stop || "Sin direccion",
    ciudad: ciudad || null,
    spedizzione: "EXTRA_PIAZZA",
    extrasPiazzaZona: "MILANO",
    kilometros: numberOf(r.KM),
    comentarios: notas.length ? notas.join(" | ") : null,
    _info: `${day.key} ${r.ESTADO} ${driver.nombre} ${driver.apellido} ${r.TARGA || "sin targa"} km ${r.KM || "-"}`,
  });
  if (stop) stops.push({ id: randomUUID(), recordId: id, orden: 0, direccion: stop });
}

console.log(`\nSERVICIOS NUEVOS: ${rows.length} (${problemas.length} con problema)`);
for (const x of rows) console.log(`  ${x.codigo.padEnd(18)} ${x._info}`);
console.log(`\nA CREAR: choferes ${[...newUsers.values()].map((u) => `${u.nombre} ${u.apellido}`).join(", ") || "-"} | vehiculos ${[...newVehicles.keys()].join(", ") || "-"} | clientes ${[...newClients.values()].map((c) => c.nombre).join(", ") || "-"}`);
for (const p of problemas) console.log(`PROBLEMA ${p}`);

if (!APPLY) {
  console.log("\n(Modo informe: no se escribio nada. Usa --aplicar para subir.)");
  await prisma.$disconnect();
  process.exit(0);
}

for (const u of newUsers.values()) {
  let email = `${u.nombre}.${u.apellido}`.toLowerCase().replace(/\s+/g, ".") + "@importado-appsheet.invalid";
  for (let n = 2; existingEmails.has(email); n += 1) email = `${u.nombre}.${u.apellido}.${n}`.toLowerCase().replace(/\s+/g, ".") + "@importado-appsheet.invalid";
  existingEmails.add(email);
  await prisma.user.create({
    data: { id: u.id, nombre: u.nombre, apellido: u.apellido, area: "DHL", cargo: "CHOFER", estado: "INACTIVO", fechaNacimiento: new Date("1900-01-01T00:00:00.000Z"), numeroCelular: "Sin dato", correoElectronico: email, password: await hashPassword(randomUUID()) },
  });
  console.log(`Chofer creado: ${u.nombre} ${u.apellido} (inactivo, sin acceso)`);
}
if (newVehicles.size) await prisma.vehiculo.createMany({ data: [...newVehicles].map(([targa, id]) => ({ id, targa, modelo: "Por completar", area: "SIN_ASIGNAR", estado: "DISPONIBLE" })), skipDuplicates: true });
if (newClients.size) await prisma.client.createMany({ data: [...newClients.values()].map((c) => ({ id: c.id, nombre: c.nombre })), skipDuplicates: true });
await prisma.record.createMany({ data: rows.map(({ _info, ...rest }) => rest) });
if (stops.length) await prisma.recordStop.createMany({ data: stops });
const undoFile = join(OUT_DIR, `piazza-appsheet-deshacer-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
writeFileSync(undoFile, JSON.stringify({ insertados: rows.map((x) => x.id) }));
console.log(`Subidos ${rows.length} servicios. Para deshacer: node scripts/import-piazza-appsheet.mjs --revertir "${undoFile}"`);
await prisma.$disconnect();
