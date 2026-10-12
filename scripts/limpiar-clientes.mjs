// Ordena la lista de clientes: une los mal escritos al cliente correcto (sus servicios pasan al otro) y borra los que no sirven.
//
//   node scripts/limpiar-clientes.mjs <clientes.json>                 -> informe SIN cambiar nada
//   node scripts/limpiar-clientes.mjs <clientes.json> --aplicar       -> aplica y guarda un archivo para deshacer
//   node scripts/limpiar-clientes.mjs --revertir <deshacer.json>      -> vuelve todo como estaba
//
//  clientes.json: { "keep": [...], "merge": { "nombre": "cliente al que se une" }, "eliminar": [nombres sin servicios] }
// Un nombre repetido (dos clientes con el mismo nombre) se junta en uno. Nunca se borra un cliente con servicios sin pasarlos antes
// a otro, y los que se piden eliminar solo se borran si no tienen ninguno.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--revertir");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

if (opt("--revertir")) {
  const undo = JSON.parse(readFileSync(opt("--revertir"), "utf8"));
  for (const c of undo.deleted) await prisma.client.create({ data: { id: c.id, nombre: c.nombre, createdAt: new Date(c.createdAt) } }).catch(() => {});
  for (const m of undo.moves) await prisma.record.updateMany({ where: { id: { in: m.recordIds } }, data: { clientId: m.from } });
  console.log(`Restaurados ${undo.deleted.length} clientes y ${undo.moves.reduce((n, m) => n + m.recordIds.length, 0)} servicios.`);
  await prisma.$disconnect();
  process.exit(0);
}
if (!file) {
  console.error("Uso: node scripts/limpiar-clientes.mjs <clientes.json> [--aplicar]");
  process.exit(1);
}

const fold = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const plan = JSON.parse(readFileSync(file, "utf8"));
const clients = await prisma.client.findMany({ select: { id: true, nombre: true, createdAt: true, _count: { select: { records: true } } } });
const byName = new Map();
for (const c of clients) {
  const k = fold(c.nombre);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(c);
}
// Un nombre truncado con "…" (texto largo pegado como cliente) se busca por su comienzo.
const findAll = (name) => {
  if (name.includes("…")) {
    const prefix = fold(name.split("…")[0]);
    return clients.filter((c) => fold(c.nombre).startsWith(prefix));
  }
  return byName.get(fold(name)) ?? [];
};
const best = (list) => [...list].sort((a, b) => b._count.records - a._count.records)[0];

const moves = []; // { from, to, fromName, toName, count }
const toDelete = new Map(); // id -> cliente
const avisos = [];

// 1) uniones pedidas
for (const [from, to] of Object.entries(plan.merge ?? {})) {
  const sources = findAll(from);
  const target = best(byName.get(fold(to)) ?? []);
  if (sources.length === 0) continue; // no existe en el sistema (solo en el reporte)
  if (!target) {
    avisos.push(`"${from}" se une a "${to}", que no existe en el sistema: se omite`);
    continue;
  }
  for (const s of sources) if (s.id !== target.id) moves.push({ from: s.id, to: target.id, fromName: s.nombre.slice(0, 50), toName: target.nombre, count: s._count.records });
}
// 2) nombres repetidos: se juntan en el que tiene mas servicios
for (const list of byName.values()) {
  if (list.length < 2) continue;
  const keeper = best(list);
  for (const c of list) if (c.id !== keeper.id && !moves.some((m) => m.from === c.id)) moves.push({ from: c.id, to: keeper.id, fromName: c.nombre, toName: keeper.nombre, count: c._count.records });
}
for (const m of moves) toDelete.set(m.from, clients.find((c) => c.id === m.from));
// 3) eliminar los pedidos (solo si no tienen servicios)
for (const name of plan.eliminar ?? []) {
  for (const c of findAll(name)) {
    if (c._count.records > 0) avisos.push(`"${c.nombre}" tiene ${c._count.records} servicios: no se elimina`);
    else toDelete.set(c.id, c);
  }
}

console.log(`Clientes hoy: ${clients.length}`);
console.log(`Se unen: ${moves.length} (pasan ${moves.reduce((n, m) => n + m.count, 0)} servicios)`);
for (const m of moves.filter((x) => x.count > 0)) console.log(`   ${m.fromName} -> ${m.toName}: ${m.count} servicios`);
console.log(`Se eliminan (sin servicios): ${[...toDelete.values()].filter((c) => !moves.some((m) => m.from === c.id)).map((c) => c.nombre.slice(0, 40)).join(", ") || "-"}`);
console.log(`Quedan: ${clients.length - toDelete.size}`);
for (const a of avisos) console.log(`AVISO: ${a}`);

if (!APPLY) {
  console.log("\nModo prueba: no se cambio nada. Para aplicar, agrega --aplicar.");
  await prisma.$disconnect();
  process.exit(0);
}

const undoPath = join(homedir(), "Downloads", `clientes-deshacer-${STAMP}.json`);
const undo = { moves: [], deleted: [] };
for (const m of moves) {
  const ids = (await prisma.record.findMany({ where: { clientId: m.from }, select: { id: true } })).map((r) => r.id);
  if (ids.length) await prisma.record.updateMany({ where: { id: { in: ids } }, data: { clientId: m.to } });
  undo.moves.push({ from: m.from, to: m.to, recordIds: ids });
}
for (const c of toDelete.values()) {
  const left = await prisma.record.count({ where: { clientId: c.id } });
  if (left > 0) {
    console.log(`No se borra "${c.nombre}": todavia tiene ${left} servicios.`);
    continue;
  }
  await prisma.client.delete({ where: { id: c.id } });
  undo.deleted.push({ id: c.id, nombre: c.nombre, createdAt: c.createdAt });
}
writeFileSync(undoPath, JSON.stringify(undo));
console.log(`\nListo. Clientes ahora: ${await prisma.client.count()}.`);
console.log(`Para deshacer: node scripts/limpiar-clientes.mjs --revertir ${undoPath}`);
await prisma.$disconnect();
