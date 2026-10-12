// Sube a la app los servicios de DHL Milano y AB Service de un "Reporte mensual" (ya filtrado a un CSV con ";" por
// scripts de apoyo: linea;fecha;conductor;targa;origen;destino;compactada;cliente;spedizzione;km). No toca ingresos ni gastos.
//
//   node scripts/import-reporte-mensual.mjs <reporte.csv> --clientes <clientes.json>             -> informe SIN escribir nada
//   node scripts/import-reporte-mensual.mjs <reporte.csv> --clientes <clientes.json> --rutas     -> igual, calculando los km que faltan
//   node scripts/import-reporte-mensual.mjs <reporte.csv> --clientes <clientes.json> --aplicar   -> sube (calcula las rutas)
//   node scripts/import-reporte-mensual.mjs --revertir <deshacer.json>                           -> borra lo que subio una corrida
//
//  --clientes  { "keep": [nombres que quedan como cliente], "merge": { "nombre mal escrito": "cliente al que se une" } }
//
// Cruza con lo que ya esta cargado (dia + targa + chofer + km / destino) para no duplicar: es idempotente. Los servicios sin km se
// completan como lo hace el sistema solo: se geocodifica el destino y se calcula la ruta desde el punto de salida (el deposito de
// DHL Milano, AB Service, o el origen del reporte si trae otro); los km de ida de esa ruta quedan como km del servicio.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { geocodeAddress } from "../src/services/geocoding.service.js";
import { calculateRoute } from "../src/services/routing.service.js";
import { rematchAssignmentsForVehicle } from "../src/services/assignmentRematch.service.js";
import { SALIDA_DHL_ROMA, defaultSalidaFor } from "../src/constants/salidaPorDefecto.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const REVERT = args.includes("--revertir");
const ROUTES = APPLY || args.includes("--rutas");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const INCLUDE = new Set((opt("--incluir") ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const file = args.find((a, i) => !a.startsWith("--") && !["--clientes", "--revertir", "--incluir"].includes(args[i - 1]));
const OUT_DIR = join(homedir(), "Downloads");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

if (REVERT) {
  const undo = JSON.parse(readFileSync(opt("--revertir"), "utf8"));
  await prisma.recordStop.deleteMany({ where: { recordId: { in: undo.recordIds } } });
  const { count } = await prisma.record.deleteMany({ where: { id: { in: undo.recordIds } } });
  const clients = await prisma.client.deleteMany({ where: { id: { in: undo.clientIds ?? [] }, records: { none: {} } } });
  console.log(`Borrados ${count} servicios y ${clients.count} clientes nuevos.`);
  await prisma.$disconnect();
  process.exit(0);
}
if (!file || !opt("--clientes")) {
  console.error("Uso: node scripts/import-reporte-mensual.mjs <reporte.csv> --clientes <clientes.json> [--rutas] [--aplicar]");
  process.exit(1);
}

// ---- utilidades ---------------------------------------------------------------------------------------------------------------------
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
  return body.map((r) => Object.fromEntries(header.map((h, k) => [h.trim(), (r[k] ?? "").trim()])));
};
const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const fold = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const key = (s) => fold(s).replace(/ /g, "");
const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const dayDate = (day) => new Date(`${day}T00:00:00.000Z`);
const romeDay = (date) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });

// ---- datos de la base ---------------------------------------------------------------------------------------------------------------
const rows = parseCsv(readFileSync(file, "utf8"));
const mapping = JSON.parse(readFileSync(opt("--clientes"), "utf8"));
const minDay = rows.map((r) => r.fecha).sort()[0];

const [users, vehicles, clients, existing] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, estado: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true } }),
  prisma.client.findMany({ select: { id: true, nombre: true } }),
  prisma.record.findMany({
    where: { fechaServicio: { gte: new Date(new Date(`${minDay}T00:00:00.000Z`).getTime() - 2 * 86400000) }, spedizzione: { in: ["DHL", "AB_SERVICE"] } },
    select: { id: true, codigo: true, descripcion: true, fechaServicio: true, driverId: true, vehicleId: true, destinazione: true, kilometros: true, client: { select: { nombre: true } }, vehicle: { select: { targa: true } } },
  }),
]);

// choferes: por nombre sin tildes; el reporte trae apellidos de mas ("Moises Chavez Garcia") o escribe distinto ("Daniel" = Dany)
const ALIAS = { "DANIEL ARANDA": "DANY ARANDA", "MOISES CHAVEZ GARCIA": "MOISES CHAVEZ", "MAURO AGOSTINELLLI": "MAURO AGOSTINELLI" };
const userByName = new Map();
for (const u of users) {
  const k = fold(`${u.nombre} ${u.apellido}`);
  if (!userByName.has(k) || u.estado === "ACTIVO") userByName.set(k, u);
}
const driverOf = (name) => {
  const k = fold(name);
  return userByName.get(ALIAS[k] ?? k) ?? null;
};
const vehicleByTarga = new Map(vehicles.map((v) => [v.targa.toUpperCase(), v]));

// clientes: lo que eligio el usuario (se mantienen o se unen a otro)
const SIN = "Sin cliente";
const mergeMap = new Map(Object.entries(mapping.merge ?? {}).map(([from, to]) => [key(from), to]));
const keepSet = new Map((mapping.keep ?? []).map((n) => [key(n), n]));
const dbClientByKey = new Map();
for (const c of clients) if (!dbClientByKey.has(key(c.nombre))) dbClientByKey.set(key(c.nombre), c);
const canonicalClient = (raw) => {
  let name = clean(raw);
  if (!name || /^SIN CLIENTE/i.test(name)) return SIN;
  const k = key(name);
  if (mergeMap.has(k)) name = mergeMap.get(k);
  if (/^SIN CLIENTE/i.test(name)) return SIN;
  const kept = keepSet.get(key(name));
  const db = dbClientByKey.get(key(name));
  return db?.nombre ?? kept ?? name;
};
const newClients = new Map();
const clientIdFor = (name) => {
  const db = dbClientByKey.get(key(name));
  if (db) return db.id;
  if (!newClients.has(key(name))) newClients.set(key(name), { id: randomUUID(), nombre: name });
  return newClients.get(key(name)).id;
};

// ---- armar cada servicio -----------------------------------------------------------------------------------------------------------
const COORD = /^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/;
const problemas = [];
const ignoradosRoma = [];
const items = [];
for (const r of rows) {
  const avisos = [];
  const driver = driverOf(r.conductor);
  if (!driver) {
    problemas.push(`linea ${r.linea}: chofer no encontrado "${r.conductor}"`);
    continue;
  }
  const vehicle = vehicleByTarga.get(r.targa.toUpperCase());
  if (!vehicle) {
    problemas.push(`linea ${r.linea}: targa no encontrada "${r.targa}"`);
    continue;
  }
  // Lo que sale del deposito de DHL Roma no se sube: los servicios de DHL Roma ya estan al dia en el sistema.
  if (/gaspare d.?urso/i.test(r.origen)) {
    ignoradosRoma.push(r.linea);
    continue;
  }
  const destino = clean(r.destino);
  const km = r.km ? Number(r.km) : null;
  const clienteNombre = canonicalClient(r.cliente);

  // punto de salida: el que trae el reporte si es distinto del deposito de siempre
  const origen = clean(r.origen);
  let salida = null;
  let salidaTexto = null;
  let zonaRoma = false;
  const coord = COORD.exec(origen);
  if (coord) salida = { direccion: origen, lat: Number(coord[1]), lng: Number(coord[2]) };
  else if (/gaspare d.?urso/i.test(origen)) {
    // Sale del deposito de DHL Roma: un servicio DHL es de DHL Roma (la salida por defecto de esa zona ya es ese deposito);
    // los de otra area (AB Service) conservan su area y llevan esa salida.
    if (r.spedizzione === "DHL") zonaRoma = true;
    else salida = SALIDA_DHL_ROMA;
  }
  else if (origen && !/tobagi|tobag/i.test(origen)) salidaTexto = origen; // p. ej. "firenze": se geocodifica al calcular
  if (/→/.test(origen)) avisos.push(`origen del reporte: ${origen}`);

  items.push({
    linea: r.linea, fecha: r.fecha, driver, vehicle, destino, km, clienteNombre, spedizzione: r.spedizzione, compactada: r.compactada === "Sí",
    salida, salidaTexto, zonaRoma, origenTexto: origen, clienteOriginal: r.cliente, avisos,
  });
}

// ---- cruce con lo que ya esta cargado (cada servicio de la base se usa una sola vez) -----------------------------------------------------
// Del mas seguro al menos seguro. El dia puede correrse 1 (un viaje largo sale un dia y el reporte lo anota al volver) y el destino se
// escribe distinto en cada lado ("Rozzano" / "via toscana 3, ROZZANO"), asi que se compara por palabras significativas.
const STOP = new Set(["MILANO", "ITALIA", "VIALE", "PIAZZA", "CORSO", "STRADA", "VIA", "ITALY", "NAVETTA", "NAVETA"]);
const tokens = (s) => new Set(fold(s).split(" ").filter((t) => t.length >= 5 && !STOP.has(t)));
const overlap = (a, b) => [...a].some((t) => b.has(t));
const destKey = (s) => key(s).slice(0, 14);
const dayNum = (day) => Math.round(Date.parse(`${day}T00:00:00.000Z`) / 86400000);
const exDb = existing.map((d) => ({ d, day: dayNum(romeDay(d.fechaServicio)), toks: tokens(d.destinazione), dk: destKey(d.destinazione) }));
const itemsInfo = (x) => ({ day: dayNum(x.fecha), toks: tokens(x.destino), dk: destKey(x.destino) });
const PASSES = [
  ["dia+targa+chofer+km", (x, i, e) => i.day === e.day && x.vehicle.targa === e.d.vehicle.targa && x.driver.id === e.d.driverId && x.km && x.km === e.d.kilometros],
  ["dia+targa+chofer+destino", (x, i, e) => i.day === e.day && x.vehicle.targa === e.d.vehicle.targa && x.driver.id === e.d.driverId && (i.dk === e.dk || overlap(i.toks, e.toks))],
  ["dia+chofer+km", (x, i, e) => i.day === e.day && x.driver.id === e.d.driverId && x.km && x.km === e.d.kilometros],
  ["dia+targa+km", (x, i, e) => i.day === e.day && x.vehicle.targa === e.d.vehicle.targa && x.km && x.km === e.d.kilometros],
  ["+-1 dia+targa+chofer+km", (x, i, e) => Math.abs(i.day - e.day) === 1 && x.vehicle.targa === e.d.vehicle.targa && x.driver.id === e.d.driverId && x.km && x.km === e.d.kilometros],
  ["+-1 dia+targa+chofer+destino", (x, i, e) => Math.abs(i.day - e.day) === 1 && x.vehicle.targa === e.d.vehicle.targa && x.driver.id === e.d.driverId && overlap(i.toks, e.toks)],
];
const used = new Set();
const matched = new Map();
for (const [name, ok] of PASSES) {
  for (const x of items) {
    if (matched.has(x)) continue;
    const info = itemsInfo(x);
    const e = exDb.find((cand) => !used.has(cand.d.id) && ok(x, info, cand));
    if (e) {
      used.add(e.d.id);
      matched.set(x, { layer: name, codigo: e.d.codigo });
    }
  }
}
// Dudosos: mismo dia, chofer y vehiculo, uno contra uno, pero sin nada en comun. No se suben (por si es el mismo servicio) y quedan listados.
const dudosos = new Map();
const pendientes = items.filter((x) => !matched.has(x));
const freeDb = exDb.filter((e) => !used.has(e.d.id));
const keyOfNew = (x) => [x.fecha, x.vehicle.targa, x.driver.id].join("|");
const keyOfDb = (e) => [romeDay(e.d.fechaServicio), e.d.vehicle.targa, e.d.driverId].join("|");
for (const x of pendientes) {
  const sameNew = pendientes.filter((y) => keyOfNew(y) === keyOfNew(x));
  const sameDb = freeDb.filter((e) => keyOfDb(e) === keyOfNew(x));
  if (sameNew.length === 1 && sameDb.length === 1) dudosos.set(x, { codigo: sameDb[0].d.codigo, km: sameDb[0].d.kilometros, destino: sameDb[0].d.destinazione, cliente: sameDb[0].d.client?.nombre, descripcion: sameDb[0].d.descripcion, fecha: romeDay(sameDb[0].d.fechaServicio) });
}
const nuevos = items.filter((x) => !matched.has(x) && (!dudosos.has(x) || INCLUDE.has(x.linea)));

// Km del reporte que no cuadran con ninguna distancia real (mas de 650 km de ida): se reemplazan por los de la ruta.
for (const x of nuevos) {
  if (x.km && x.km > 650) {
    x.kmReporte = x.km;
    x.km = null;
  }
}

// ---- rutas: los km que faltan salen del recorrido (como lo hace el sistema solo) -----------------------------------------------------
const enrich = async (x) => {
  try {
    const geo = await geocodeAddress(x.destino);
    x.stop = { lat: geo.lat, lng: geo.lng };
    let salida = x.salida ?? defaultSalidaFor({ spedizzione: x.spedizzione, extrasPiazzaZona: x.zonaRoma ? "ROMA" : undefined });
    if (!x.salida && x.salidaTexto) {
      const g = await geocodeAddress(x.salidaTexto);
      salida = { direccion: x.salidaTexto, lat: g.lat, lng: g.lng };
      x.salida = salida;
    }
    const ruta = await calculateRoute([salida, { lat: geo.lat, lng: geo.lng }]);
    if (ruta) {
      x.ruta = ruta;
      if (!x.km) {
        x.kmRuta = Math.round(ruta.distanciaKm);
        x.avisos.push(x.kmReporte ? `el reporte decia ${x.kmReporte} km: se usaron ${x.kmRuta} km por ruta` : `km aproximados por ruta desde ${salida.direccion}`);
      }
    } else x.avisos.push("no se pudo calcular la ruta");
  } catch (err) {
    x.avisos.push(`no se pudo ubicar el destino: ${err.message}`);
  }
};
if (ROUTES) {
  const queue = nuevos.filter((x) => !x.km);
  let done = 0;
  const worker = async () => {
    for (;;) {
      const x = queue.shift();
      if (!x) return;
      await enrich(x);
      done += 1;
      if (done % 20 === 0) console.log(`  rutas calculadas: ${done}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---- viajes compactados: mismo dia, chofer y vehiculo con la marca "Si" y al menos 2 servicios ----------------------------------------------
const groups = new Map();
for (const x of nuevos.filter((n) => n.compactada)) {
  const k = [x.fecha, x.driver.id, x.vehicle.id].join("|");
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(x);
}
let compactGroups = 0;
for (const list of groups.values()) {
  if (list.length < 2) continue;
  const id = randomUUID();
  compactGroups += 1;
  list.sort((a, b) => Number(a.linea) - Number(b.linea)).forEach((x, i) => {
    x.compactadoId = id;
    x.compactadoOrden = i + 1;
  });
}

// ---- informe ------------------------------------------------------------------------------------------------------------------------
const count = (list, fn) => list.reduce((m, i) => m.set(fn(i), (m.get(fn(i)) ?? 0) + 1), new Map());
const show = (title, map) => console.log(`${title}: ${[...map].map(([k, v]) => `${k || "-"} ${v}`).join(" | ")}`);
console.log(`\nReporte: ${rows.length} filas | ya estaban en el sistema: ${matched.size} | dudosos (no se suben): ${dudosos.size} | a subir: ${nuevos.length} | con problema: ${problemas.length}`);
show("Cruce con lo existente", count([...matched.values()], (m) => m.layer));
show("A subir por area", count(nuevos, (x) => x.spedizzione));
show("A subir por mes", count(nuevos, (x) => x.fecha.slice(0, 7)));
show("A subir por chofer", count(nuevos, (x) => `${x.driver.nombre} ${x.driver.apellido}`));
console.log(`Km: con km en el reporte ${nuevos.filter((x) => x.km).length} | sin km ${nuevos.filter((x) => !x.km).length}${ROUTES ? ` (calculados por ruta: ${nuevos.filter((x) => x.kmRuta).length}, sin poder calcular: ${nuevos.filter((x) => !x.km && !x.kmRuta).length})` : " (se calculan al subir; agrega --rutas para verlos ahora)"}`);
console.log(`Viajes compactados nuevos: ${compactGroups} grupos`);
console.log(`Ignorados por salir de Roma (DHL Roma ya esta al dia): ${ignoradosRoma.length} (lineas ${ignoradosRoma.join(", ")})`);
console.log(`Origen distinto al deposito: ${nuevos.filter((x) => x.salida).length} | DHL de Roma: ${nuevos.filter((x) => x.zonaRoma).length} | km del reporte reemplazados por ruta: ${nuevos.filter((x) => x.kmReporte).length}`);
const clientesNuevos = [...new Set(nuevos.map((x) => x.clienteNombre).filter((n) => !dbClientByKey.has(key(n))))];
console.log(`Clientes a crear (${clientesNuevos.length}): ${clientesNuevos.join(", ") || "-"}`);
if (problemas.length) console.log(`PROBLEMAS:\n  ${problemas.join("\n  ")}`);

const reportPath = join(OUT_DIR, "reporte-mensual-informe.csv");
writeFileSync(
  reportPath,
  [
    ["linea", "fecha", "area", "chofer", "targa", "cliente", "cliente_original", "destino", "km_reporte", "km_ruta", "estado", "cruce", "avisos"],
    ...items.map((x) => [
      x.linea, x.fecha, x.spedizzione, `${x.driver.nombre} ${x.driver.apellido}`, x.vehicle.targa, x.clienteNombre, x.clienteOriginal, x.destino, x.km ?? "", x.kmRuta ?? "",
      matched.has(x) ? "ya estaba" : dudosos.has(x) ? "dudoso" : "nuevo", matched.get(x)?.layer ?? (dudosos.has(x) ? `parecido a ${dudosos.get(x).codigo} (${dudosos.get(x).km ?? "-"} km, ${dudosos.get(x).destino})` : ""), x.avisos.join("; "),
    ]),
  ].map((row) => row.map(csvEscape).join(";")).join("\n"),
);
console.log(`Informe: ${reportPath}`);
if (dudosos.size) {
  console.log("\nDUDOSOS (no se suben salvo que uses --incluir <lineas>):");
  for (const [x, d] of dudosos) console.log(`  linea ${x.linea}: REPORTE ${x.fecha} ${x.driver.nombre} ${x.vehicle.targa} | cliente "${x.clienteOriginal}" | destino "${x.destino}" | km ${x.km ?? "-"}  <>  SISTEMA ${d.codigo} ${d.fecha} | cliente "${d.cliente}" | destino "${d.destino}" | km ${d.km ?? "-"} | "${(d.descripcion ?? "").slice(0, 90)}"`);
}

if (!APPLY) {
  console.log("Modo prueba: no se escribio nada en los servicios. Para subir, agrega --aplicar.");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- subir ---------------------------------------------------------------------------------------------------------------------------
const undoPath = join(OUT_DIR, `reporte-mensual-deshacer-${STAMP}.json`);
const undo = { recordIds: [], clientIds: [] };
for (const x of nuevos) clientIdFor(x.clienteNombre); // arma la lista de clientes a crear antes de crearlos
if (newClients.size) {
  const toCreate = [...newClients.values()].filter((c) => nuevos.some((x) => key(x.clienteNombre) === key(c.nombre)));
  await prisma.client.createMany({ data: toCreate.map((c) => ({ id: c.id, nombre: c.nombre })), skipDuplicates: true });
  undo.clientIds = toCreate.map((c) => c.id);
  console.log(`Clientes creados: ${toCreate.length}`);
}
writeFileSync(undoPath, JSON.stringify(undo));

const recordsData = [];
const stopsData = [];
for (const x of nuevos) {
  const id = randomUUID();
  const fechaServicio = dayDate(x.fecha);
  const nota = [];
  if (x.kmRuta) nota.push(x.kmReporte ? `Km por ruta: el reporte decia ${x.kmReporte} km.` : "Km aproximados por ruta (el reporte no traia km).");
  if (/→/.test(x.origenTexto)) nota.push(`Origen segun el reporte: ${x.origenTexto}`);
  const ruta = x.ruta;
  recordsData.push({
    id,
    estado: "CONSEGNATO",
    driverId: x.driver.id,
    vehicleId: x.vehicle.id,
    clientId: clientIdFor(x.clienteNombre),
    fechaServicio,
    eta: fechaServicio,
    descripcion: `${x.clienteNombre} - ${x.destino}`.slice(0, 500),
    codigo: `RM1012-${x.linea}`,
    destinazione: x.destino || "Sin direccion",
    spedizzione: x.spedizzione,
    extrasPiazzaZona: x.zonaRoma ? "ROMA" : null,
    kilometros: x.km ?? x.kmRuta ?? null,
    comentarios: nota.length ? nota.join(" ") : null,
    compactadoId: x.compactadoId ?? null,
    compactadoOrden: x.compactadoOrden ?? null,
    ...(x.salida ? { salidaDireccion: x.salida.direccion, salidaLat: x.salida.lat, salidaLng: x.salida.lng } : {}),
    ...(ruta ? { rutaDistanciaKm: ruta.distanciaKm, rutaDuracionMin: ruta.duracionMin, rutaGeometria: ruta.geometria, rutaCalculadaAt: new Date() } : {}),
  });
  if (x.destino) stopsData.push({ id: randomUUID(), recordId: id, orden: 0, direccion: x.destino, lat: x.stop?.lat ?? null, lng: x.stop?.lng ?? null, geocodedAt: x.stop ? new Date() : null });
}
for (let i = 0; i < recordsData.length; i += 100) {
  const chunk = recordsData.slice(i, i + 100);
  await prisma.record.createMany({ data: chunk, skipDuplicates: true });
  undo.recordIds.push(...chunk.map((c) => c.id));
  writeFileSync(undoPath, JSON.stringify(undo));
  const ids = new Set(chunk.map((c) => c.id));
  await prisma.recordStop.createMany({ data: stopsData.filter((s) => ids.has(s.recordId)), skipDuplicates: true });
  console.log(`  ${Math.min(i + 100, recordsData.length)}/${recordsData.length} servicios subidos...`);
}
console.log(`\nSubidos ${recordsData.length} servicios.`);
console.log(`Para deshacer: node scripts/import-reporte-mensual.mjs --revertir ${undoPath}`);

// Los peajes y cargas de combustible que esperaban un servicio de estos vehiculos se vuelven a evaluar (sin avisos).
for (const vehicleId of new Set(nuevos.map((x) => x.vehicle.id))) await rematchAssignmentsForVehicle(vehicleId);
console.log("Peajes y combustible re-evaluados.");
await prisma.$disconnect();
