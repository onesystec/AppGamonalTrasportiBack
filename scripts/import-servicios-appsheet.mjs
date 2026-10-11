// Sube a la app los servicios (DHL, AB Service y otros) exportados de AppSheet (CSV con ";") que todavia no estan, y corrige el chofer de los que ya
// estan cuando el comentario dice quien lo hizo realmente ("lo iso kevin"). No toca AppSheet ni manda avisos: escribe directo en la base.
//
//   node scripts/import-servicios-appsheet.mjs <archivo.csv>                 -> informe SIN escribir nada
//   node scripts/import-servicios-appsheet.mjs <archivo.csv> --aplicar       -> sube, corrige choferes y vuelve a asignar mancatos / combustible
//   node scripts/import-servicios-appsheet.mjs --revertir <deshacer.json>    -> borra lo subido y devuelve los choferes corregidos
//
// Como saber si un servicio ya esta: se cruza con la base por dia + texto + km + targa, y si no, por dia + cliente + km (cada servicio de la base
// se usa una sola vez, asi que dos servicios iguales el mismo dia cuentan por separado). Lo que no tiene pareja se sube.
// Despues de subir se re-evaluan los peajes (mancatos, desde el 1 de julio) y las cargas de combustible de los vehiculos tocados: solo se
// asignan solos los que encajan; no se crea ningun aviso nuevo (los faltantes cuentan desde octubre y nada de esto manda notificaciones).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { ESTADO_MAP, fromRomeParts, SPEDIZZIONE_MAP } from "../src/constants/appsheetMaps.js";
import { rematchCombustibleVehicle } from "../src/services/combustibleMatching.service.js";
import { rematchVehicle } from "../src/services/mancatoMatching.service.js";
import { hashPassword } from "../src/utils/password.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const REVERT = args.includes("--revertir");
const file = args.find((a) => !a.startsWith("--"));
const OUT_DIR = join(homedir(), "Downloads");
const DESDE = new Date("2026-01-01T00:00:00.000Z");

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
const csvDesc = (r) => fold(r["DATOS CONSEGNA"]) || fold(`${r.CLIENTE} - ${r.CIUDAD}`);
const LEVELS = [
  { name: "dia+texto+km+targa", c: (r) => [dayOf(r.DATA)?.key, csvDesc(r), kmKey(numberOf(r.KM)), foldKey(targaOf(r.TARGA))].join("|"), d: (r) => [romeDay(r.fechaServicio), fold(r.descripcion), kmKey(r.kilometros), foldKey(r.vehicle.targa)].join("|") },
  { name: "dia+texto+km", c: (r) => [dayOf(r.DATA)?.key, csvDesc(r), kmKey(numberOf(r.KM))].join("|"), d: (r) => [romeDay(r.fechaServicio), fold(r.descripcion), kmKey(r.kilometros)].join("|") },
  { name: "dia+cliente+km+targa", c: (r) => [dayOf(r.DATA)?.key, foldKey(r.CLIENTE), kmKey(numberOf(r.KM)), foldKey(targaOf(r.TARGA))].join("|"), d: (r) => [romeDay(r.fechaServicio), foldKey(r.client.nombre), kmKey(r.kilometros), foldKey(r.vehicle.targa)].join("|") },
  { name: "dia+cliente+km", c: (r) => [dayOf(r.DATA)?.key, foldKey(r.CLIENTE), kmKey(numberOf(r.KM))].join("|"), d: (r) => [romeDay(r.fechaServicio), foldKey(r.client.nombre), kmKey(r.kilometros)].join("|") },
];

const pairUp = (csvRows, dbRows) => {
  let pendCsv = csvRows.slice();
  let pendDb = dbRows.slice();
  const pairs = [];
  for (const L of LEVELS) {
    const idx = new Map();
    for (const r of pendDb) {
      const k = L.d(r);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(r);
    }
    const used = new Set();
    const next = [];
    for (const c of pendCsv) {
      const arr = idx.get(L.c(c));
      if (arr?.length) {
        const d = arr.shift();
        used.add(d.id);
        pairs.push({ csv: c, db: d, level: L.name });
      } else next.push(c);
    }
    pendDb = pendDb.filter((r) => !used.has(r.id));
    pendCsv = next;
  }
  return { pairs, nuevos: pendCsv, soloBase: pendDb };
};

// ---- deshacer -------------------------------------------------------------------------------------------------------------------------
if (REVERT) {
  if (!file || !existsSync(file)) {
    console.error("Uso: node scripts/import-servicios-appsheet.mjs --revertir <deshacer.json>");
    process.exit(1);
  }
  const undo = JSON.parse(readFileSync(file, "utf8"));
  const del = await prisma.record.deleteMany({ where: { id: { in: undo.insertados } } });
  let devueltos = 0;
  for (const c of undo.correcciones) {
    await prisma.record.update({ where: { id: c.id }, data: { driverId: c.antes } });
    devueltos += 1;
  }
  console.log(`Borrados ${del.count} servicios y devueltos ${devueltos} choferes. Los choferes, vehiculos y clientes creados se dejan.`);
  await prisma.$disconnect();
  process.exit(0);
}

if (!file || !existsSync(file)) {
  console.error("Uso: node scripts/import-servicios-appsheet.mjs <archivo.csv> [--aplicar]");
  process.exit(1);
}

const csv = parseCsv(readFileSync(file, "utf8")).filter((r) => dayOf(r.DATA) && dayOf(r.DATA).y === 2026);
console.log(`CSV: ${csv.length} servicios de 2026.`);

const [users, vehicles, clients, dbRecords] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, correoElectronico: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true } }),
  prisma.client.findMany({ select: { id: true, nombre: true } }),
  prisma.record.findMany({
    where: { fechaServicio: { gte: new Date(DESDE.getTime() - 3 * 86400000) }, OR: [{ spedizzione: null }, { spedizzione: { not: "EXTRA_PIAZZA" } }] },
    select: {
      id: true, descripcion: true, fechaServicio: true, kilometros: true, driverId: true,
      vehicle: { select: { targa: true } }, client: { select: { nombre: true } },
    },
  }),
]);

const { pairs, nuevos, soloBase } = pairUp(csv, dbRecords);
console.log(`Ya estan en el sistema: ${pairs.length}. Faltan: ${nuevos.length}. En el sistema y no en el CSV (no se tocan): ${soloBase.length}.`);

// ---- resolver choferes, vehiculos y clientes ----------------------------------------------------------------------------------------
const userByName = new Map(users.map((u) => [fold(`${u.nombre} ${u.apellido}`), u]));
const existingEmails = new Set(users.map((u) => u.correoElectronico.toLowerCase()));
// Choferes que se crean (inactivos, sin acceso) si el comentario los nombra y todavia no existen.
const CREAR_CHOFER = {
  "EDUAR FARMACIA": { nombre: "Eduar", apellido: "Farmacia" },
  "JHOSHUA GONZALES": { nombre: "Jhoshua", apellido: "Gonzales" },
  "GUSTAVO MUNOS": { nombre: "Gustavo", apellido: "Muños" },
};
const newUsers = new Map(); // nombre normalizado -> { id, nombre, apellido }
const driverNameOf = (full) => {
  if (userByName.has(full)) return userByName.get(full);
  const crear = CREAR_CHOFER[full];
  if (crear) {
    if (!newUsers.has(full)) newUsers.set(full, { id: randomUUID(), ...crear });
    return newUsers.get(full);
  }
  return null;
};

const problemas = []; // filas que no se pueden subir
const baseDriver = (r) => {
  const key = fold(r.AUTISTA);
  return driverNameOf(AUTISTA_ALIAS[key] ?? key);
};

const notasDescartadas = new Map();
const resolveDriver = (r) => {
  const base = baseDriver(r);
  const nota = driverFromNota(r.NOTAS);
  if (nota.motivo) notasDescartadas.set(`${r.NOTAS} -> ${nota.motivo}`, (notasDescartadas.get(`${r.NOTAS} -> ${nota.motivo}`) ?? 0) + 1);
  const real = nota.name ? driverNameOf(nota.name) : null;
  return { base, real: real ?? base, porNota: Boolean(real && base && real.id !== base.id) };
};

const vehicleByTarga = new Map(vehicles.map((v) => [foldKey(v.targa), v.id]));
const GENERIC_TARGA = "NOLEGGIO/OTRO";
const newVehicles = new Map(); // targa -> id
const vehicleIdFor = (r) => {
  const targa = targaOf(r.TARGA);
  if (!targa) return vehicleByTarga.get(foldKey(GENERIC_TARGA)) ?? null;
  const known = vehicleByTarga.get(foldKey(targa));
  if (known) return known;
  if (!/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(targa)) return null;
  if (!newVehicles.has(targa)) newVehicles.set(targa, randomUUID());
  return newVehicles.get(targa);
};

const clientByName = new Map(clients.map((c) => [c.nombre.trim().toLowerCase(), c.id]));
const newClients = new Map(); // nombre en minusculas -> { id, nombre }
const SIN_CLIENTE = "Sin cliente";
const clientIdFor = (r) => {
  const nombre = r.CLIENTE.trim() || SIN_CLIENTE;
  const key = nombre.toLowerCase();
  if (clientByName.has(key)) return clientByName.get(key);
  if (!newClients.has(key)) newClients.set(key, { id: randomUUID(), nombre });
  return newClients.get(key).id;
};

// ---- armar los servicios nuevos ---------------------------------------------------------------------------------------------------
const rows = [];
const stops = [];
let porNota = 0;
for (const r of nuevos) {
  const estado = ESTADO_MAP[r.ESTADO.toUpperCase()];
  if (!estado) {
    problemas.push({ linea: r._linea, motivo: `estado no reconocido: "${r.ESTADO}"` });
    continue;
  }
  const { real, porNota: cambiado } = resolveDriver(r);
  if (!real) {
    problemas.push({ linea: r._linea, motivo: `chofer no encontrado: "${r.AUTISTA}"` });
    continue;
  }
  const vehicleId = vehicleIdFor(r);
  if (!vehicleId) {
    problemas.push({ linea: r._linea, motivo: `targa no valida: "${r.TARGA}"` });
    continue;
  }
  if (cambiado) porNota += 1;

  const day = dayOf(r.DATA);
  const fechaServicio = new Date(Date.UTC(day.y, day.mo - 1, day.d));
  const etaMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(r.ETA);
  const eta = etaMatch ? fromRomeParts(Number(etaMatch[3]), Number(etaMatch[2]), Number(etaMatch[1]), Number(etaMatch[4]), Number(etaMatch[5])) : fechaServicio;

  const spedRaw = r.SPEDIZZIONE.toUpperCase().replace("STEPHANIA", "STEFANIA");
  const spedizzione = SPEDIZZIONE_MAP[spedRaw];
  if (spedRaw && !spedizzione) {
    problemas.push({ linea: r._linea, motivo: `spedizzione no reconocida: "${r.SPEDIZZIONE}"` });
    continue;
  }

  const ciudad = r.CIUDAD.trim();
  const calleRaw = r.DESTINAZIONE.trim();
  const first = ciudad.split(/\s+/)[0]?.toLowerCase();
  const calle = first && calleRaw.toLowerCase().endsWith(` ${first}`) ? calleRaw.slice(0, calleRaw.length - first.length).trim() : calleRaw;
  let stop = calle ? (ciudad ? `${calle}, ${ciudad}` : calle) : ciudad;
  if (calleRaw.toUpperCase() === "VARIOS" || ciudad.toUpperCase() === "VARIOS") stop = "Milano, Italia";

  const cliente = r.CLIENTE.trim();
  const notas = [];
  if (r.NOTAS) notas.push(r.NOTAS);
  if (r["N. PART"]) notas.push(`N. part: ${r["N. PART"]}`);
  if (r.ATTESA && r.ATTESA !== "00:00") notas.push(`Espera: ${r.ATTESA}`);
  const areaC = numberOf(r["AREA C"]);

  const id = randomUUID();
  rows.push({
    id,
    estado,
    driverId: real.id,
    vehicleId,
    clientId: clientIdFor(r),
    fechaServicio,
    eta,
    descripcion: r["DATOS CONSEGNA"] || (cliente ? `${cliente} - ${ciudad}` : ciudad || "Sin descripcion"),
    codigo: `AS1011-${r._linea}`,
    destinazione: stop || "Sin direccion",
    ciudad: ciudad || null,
    spedizzione: spedizzione ?? null,
    kilometros: numberOf(r.KM),
    areaC: areaC && areaC > 0 ? areaC : null,
    comentarios: notas.length ? notas.join(" | ") : null,
    _csv: r,
    _mes: r.MES,
    _driver: `${real.nombre} ${real.apellido}`,
  });
  if (stop) stops.push({ id: randomUUID(), recordId: id, orden: 0, direccion: stop });
}

// ---- correcciones de chofer en servicios que ya estaban ------------------------------------------------------------------------------
const correcciones = [];
for (const { csv: r, db } of pairs) {
  const { base, real, porNota: cambiado } = resolveDriver(r);
  if (!cambiado || !base || !real) continue;
  // Solo si el servicio sigue con el chofer que traia AppSheet (si alguien ya lo cambio a mano, no se pisa).
  if (db.driverId !== base.id) continue;
  correcciones.push({ id: db.id, antes: db.driverId, despues: real.id, de: `${base.nombre} ${base.apellido}`, a: `${real.nombre} ${real.apellido}`, fecha: dayOf(r.DATA).key, nota: r.NOTAS, cliente: r.CLIENTE });
}

// ---- informe ----------------------------------------------------------------------------------------------------------------------------
const count = (arr, f) => {
  const m = new Map();
  for (const x of arr) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
console.log(`\nSERVICIOS NUEVOS: ${rows.length} (${problemas.length} con problema)`);
console.log("  por mes:", count(rows, (x) => x._mes).map(([k, v]) => `${k}: ${v}`).join(" | "));
console.log("  por tipo:", count(rows, (x) => x.spedizzione ?? "-").map(([k, v]) => `${k}: ${v}`).join(" | "));
console.log("  por chofer:", count(rows, (x) => x._driver).map(([k, v]) => `${k}: ${v}`).join(" | "));
console.log(`  chofer cambiado por el comentario: ${porNota}`);
console.log(`  sin cliente: ${rows.filter((x) => !x._csv.CLIENTE.trim()).length}`);
console.log(`\nA CREAR: choferes ${[...newUsers.values()].map((u) => `${u.nombre} ${u.apellido}`).join(", ") || "-"} | vehiculos ${[...newVehicles.keys()].join(", ") || "-"} | clientes ${newClients.size} (${[...newClients.values()].map((c) => c.nombre).join(", ")})`);
console.log(`\nCORRECCIONES DE CHOFER en servicios que ya estaban: ${correcciones.length}`);
console.log("  ", count(correcciones, (c) => `${c.de} -> ${c.a}`).map(([k, v]) => `${k}: ${v}`).join(" | "));
console.log(`\nCOMENTARIOS CON VERBO PERO SIN CHOFER CLARO (no se cambia nada):`);
for (const [k, v] of [...notasDescartadas].sort((a, b) => b[1] - a[1])) console.log(`  ${v}x ${k}`);
if (problemas.length) {
  console.log("\nPROBLEMAS (no se suben):");
  for (const p of problemas) console.log(`  linea ${p.linea}: ${p.motivo}`);
}

const reportRows = [
  ["tipo", "fecha", "cliente", "km", "targa", "chofer en AppSheet", "chofer que quedara", "comentario"],
  ...rows.map((x) => ["NUEVO", dayOf(x._csv.DATA).key, x._csv.CLIENTE || SIN_CLIENTE, x._csv.KM, x._csv.TARGA, x._csv.AUTISTA, x._driver, x._csv.NOTAS]),
  ...correcciones.map((c) => ["CORRECCION", c.fecha, c.cliente, "", "", c.de, c.a, c.nota]),
];
const reportFile = join(OUT_DIR, "servicios-appsheet-informe.csv");
writeFileSync(reportFile, `﻿${reportRows.map((r) => r.map(csvEscape).join(";")).join("\n")}\n`);
console.log(`\nInforme detallado: ${reportFile}`);

if (!APPLY) {
  console.log("\n(Modo informe: no se escribio nada. Usa --aplicar para subir.)");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- aplicar --------------------------------------------------------------------------------------------------------------------------
for (const [full, u] of newUsers) {
  let email = `${u.nombre}.${u.apellido}`.toLowerCase().replace(/\s+/g, ".") + "@importado-appsheet.invalid";
  for (let n = 2; existingEmails.has(email); n += 1) email = `${u.nombre}.${u.apellido}.${n}`.toLowerCase() + "@importado-appsheet.invalid";
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
  console.log(`Chofer creado: ${titleCase(full)} (inactivo, sin acceso)`);
}
if (newVehicles.size) {
  await prisma.vehiculo.createMany({
    data: [...newVehicles].map(([targa, id]) => ({ id, targa, modelo: "Por completar", area: "SIN_ASIGNAR", estado: "DISPONIBLE" })),
    skipDuplicates: true,
  });
  console.log(`Vehiculos creados: ${[...newVehicles.keys()].join(", ")}`);
}
if (newClients.size) {
  await prisma.client.createMany({ data: [...newClients.values()].map((c) => ({ id: c.id, nombre: c.nombre })), skipDuplicates: true });
  console.log(`Clientes creados: ${newClients.size}`);
}

const CHUNK = 100;
const recordData = rows.map(({ _csv, _mes, _driver, ...rest }) => rest);
for (let i = 0; i < recordData.length; i += CHUNK) {
  await prisma.record.createMany({ data: recordData.slice(i, i + CHUNK) });
  console.log(`  servicios ${Math.min(i + CHUNK, recordData.length)}/${recordData.length}`);
}
for (let i = 0; i < stops.length; i += 500) await prisma.recordStop.createMany({ data: stops.slice(i, i + 500) });

const byNewDriver = new Map();
for (const c of correcciones) byNewDriver.set(c.despues, [...(byNewDriver.get(c.despues) ?? []), c.id]);
for (const [driverId, ids] of byNewDriver) await prisma.record.updateMany({ where: { id: { in: ids } }, data: { driverId } });
console.log(`Choferes corregidos en servicios existentes: ${correcciones.length}`);

const undoFile = join(OUT_DIR, `servicios-appsheet-deshacer-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
writeFileSync(undoFile, JSON.stringify({ insertados: rows.map((x) => x.id), correcciones: correcciones.map((c) => ({ id: c.id, antes: c.antes })) }));
console.log(`Para deshacer: node scripts/import-servicios-appsheet.mjs --revertir "${undoFile}"`);

// Fase 2: los peajes y cargas de combustible de los vehiculos tocados se vuelven a evaluar, y los que claramente corresponden a un
// servicio se asignan solos (los mancatos solo desde el 1 de julio de 2026; ver ASIGNACION_DESDE).
const vehicleIds = new Set(rows.map((x) => x.vehicleId));
if (correcciones.length) {
  const recs = await prisma.record.findMany({ where: { id: { in: correcciones.map((c) => c.id) } }, select: { vehicleId: true } });
  for (const r of recs) vehicleIds.add(r.vehicleId);
}
let mRev = 0;
let mCam = 0;
let cRev = 0;
let cCam = 0;
for (const vehicleId of vehicleIds) {
  const m = await rematchVehicle(vehicleId);
  const c = await rematchCombustibleVehicle(vehicleId);
  mRev += m.revisados;
  mCam += m.cambiados;
  cRev += c.revisados;
  cCam += c.cambiados;
}
console.log(`Peajes (mancatos): ${mRev} revisados, ${mCam} cambiaron de servicio/estado. Combustible: ${cRev} revisadas, ${cCam} cambiaron.`);
await prisma.$disconnect();
