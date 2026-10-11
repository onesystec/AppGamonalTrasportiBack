// Descarga UNA vez el catalogo de peajes de Italia de OpenStreetMap (casetas barrier=toll_booth y portales
// highway=toll_gantry), agrupa los carriles de una misma caseta y lo guarda en data/peajes-italia.json y en la tabla "peajes".
//
//   node scripts/import-peajes-osm.mjs               -> usa data/peajes-italia.json si existe; si no, lo descarga
//   node scripts/import-peajes-osm.mjs --descargar   -> vuelve a descargar de OpenStreetMap (datos de voluntarios: se pueden
//                                                       actualizar de vez en cuando)
// Datos (c) colaboradores de OpenStreetMap, licencia ODbL.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/config/prisma.js";

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../data/peajes-italia.json");
const OVERPASS = "https://overpass-api.de/api/interpreter";
const QUERY =
  '[out:json][timeout:180];area["ISO3166-1"="IT"][admin_level=2]->.it;(node["barrier"="toll_booth"](area.it);node["highway"="toll_gantry"](area.it););out body;';
// Dos nodos a menos de esto (y con el mismo nombre, o alguno sin nombre) son carriles de la misma caseta.
const CLUSTER_M = 400;

const toRad = (d) => (d * Math.PI) / 180;
const meters = (a, b) => {
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const top = (values) => {
  const count = new Map();
  values.filter(Boolean).forEach((v) => count.set(v, (count.get(v) ?? 0) + 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const cleanOperator = (op) =>
  op
    ? op
        .replace(/\s*S\.?\s?p\.?\s?A\.?/i, "")
        .replace(/^ASPI$/i, "Autostrade per l'Italia")
        .trim()
    : null;

const download = async () => {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "User-Agent": "GamonalDriver/1.0 (catalogo de peajes, uso interno)", "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" },
    body: new URLSearchParams({ data: QUERY }),
  });
  if (!res.ok) throw new Error(`Overpass respondio ${res.status}`);
  return (await res.json()).elements;
};

const cluster = (elements) => {
  const nodes = elements.map((e) => ({
    id: e.id,
    lat: e.lat,
    lng: e.lon,
    name: e.tags?.name?.trim() || null,
    operator: cleanOperator(e.tags?.operator),
    gantry: e.tags?.highway === "toll_gantry",
  }));
  const groups = [];
  for (const node of nodes) {
    const group = groups.find((g) => (!g.name || !node.name || g.name === node.name) && g.nodes.some((n) => meters(n, node) <= CLUSTER_M));
    if (group) {
      group.nodes.push(node);
      group.name ??= node.name;
    } else groups.push({ name: node.name, nodes: [node] });
  }
  return groups.map((g) => ({
    osmId: String(Math.min(...g.nodes.map((n) => n.id))),
    nombre: top(g.nodes.map((n) => n.name)),
    operador: top(g.nodes.map((n) => n.operator)),
    tipo: g.nodes.every((n) => n.gantry) ? "PORTALE" : "CASELLO",
    lat: Number((g.nodes.reduce((s, n) => s + n.lat, 0) / g.nodes.length).toFixed(6)),
    lng: Number((g.nodes.reduce((s, n) => s + n.lng, 0) / g.nodes.length).toFixed(6)),
    carriles: g.nodes.length,
  }));
};

let peajes;
if (process.argv.includes("--descargar") || !existsSync(FILE)) {
  const elements = await download();
  peajes = cluster(elements);
  writeFileSync(FILE, JSON.stringify({ fuente: "OpenStreetMap (ODbL)", descargadoAt: new Date().toISOString(), nodosOsm: elements.length, peajes }, null, 0));
  console.log(`Descargados ${elements.length} puntos de OpenStreetMap -> ${peajes.length} peajes (archivo ${FILE})`);
} else {
  peajes = JSON.parse(readFileSync(FILE, "utf8")).peajes;
  console.log(`Leidos ${peajes.length} peajes de ${FILE}`);
}

// Se reemplaza el catalogo completo en una transaccion (es solo lectura para el resto de la app).
await prisma.$transaction([prisma.peaje.deleteMany(), prisma.peaje.createMany({ data: peajes })]);
console.log(`Guardados ${await prisma.peaje.count()} peajes en la base.`);
await prisma.$disconnect();
