// Descarga UNA vez los sitios donde parar de Italia de OpenStreetMap (areas de servicio highway=services, areas de descanso
// highway=rest_area y parkings aptos para camiones amenity=parking + hgv=yes/designated) y los guarda en data/areas-parada-italia.json.
// Es lo que usa el "punto de encuentro" del Mapa: asi no depende de ningun servicio externo al buscar.
//
//   node scripts/importar-areas-parada-osm.mjs                   -> descarga de OpenStreetMap (Overpass, por cuadriculas) y regenera el archivo
//   node scripts/importar-areas-parada-osm.mjs --crudo ruta.json -> regenera el archivo desde una descarga ya hecha (lista de elementos de Overpass)
// Datos de voluntarios: con repetirlo una vez al ano alcanza. Datos (c) colaboradores de OpenStreetMap, licencia ODbL.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../data/areas-parada-italia.json");
const SERVERS = ["https://overpass.openstreetmap.fr/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
// Consultas simples (etiqueta exacta): las que usan expresiones regulares tardan demasiado y los servidores publicos las cortan.
const FILTERS = ['["highway"="services"]', '["highway"="rest_area"]', '["amenity"="parking"]["hgv"="yes"]', '["amenity"="parking"]["hgv"="designated"]'];
const STEP = 1.5;
const BOUNDS = { south: 36, north: 47.2, west: 6.4, east: 18.8 };
const CONCURRENCY = 4;
// Dos sitios a menos de esto son el mismo (la gasolinera de un area de servicio es el area de servicio): queda el mas importante.
const DUPLICADO_M = 400;
const PRIORIDAD = { services: 0, rest_area: 1, parking: 2 };

const toRad = (d) => (d * Math.PI) / 180;
const meters = (a, b) => {
  const h = Math.sin(toRad(b.la - a.la) / 2) ** 2 + Math.cos(toRad(a.la)) * Math.cos(toRad(b.la)) * Math.sin(toRad(b.lo - a.lo) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

const query = async (s, w, n, e, filter) => {
  const body = new URLSearchParams({ data: `[out:json][timeout:60][bbox:${s},${w},${n},${e}];nwr${filter};out center tags;` });
  let last = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const url of SERVERS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "User-Agent": "GamonalDriver/1.0 (sitios de parada, uso interno)", "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body,
          signal: AbortSignal.timeout(70000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Un servidor sobrecargado devuelve 200 con la lista vacia y un "remark" de error.
        if (data.remark?.toLowerCase().includes("error") && !data.elements?.length) throw new Error(data.remark.slice(0, 60));
        return data.elements;
      } catch (err) {
        last = err.message;
      }
    }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(`Fallo ${s},${w} ${filter}: ${last}`);
};

const download = async () => {
  const jobs = [];
  for (let s = BOUNDS.south; s < BOUNDS.north; s += STEP)
    for (let w = BOUNDS.west; w < BOUNDS.east; w += STEP) for (const f of FILTERS) jobs.push([s, w, s + STEP, w + STEP, f].map((v, i) => (i < 4 ? Number(v.toFixed(2)) : v)));
  const found = new Map();
  let done = 0;
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        for (const el of await query(...job)) found.set(`${el.type}${el.id}`, el);
        done += 1;
        if (done % 20 === 0) console.log(`${done}/${jobs.length} consultas, ${found.size} sitios`);
      }
    })
  );
  return [...found.values()];
};

// La cuadricula tambien coge el norte de Africa (Argelia, Tunez): al sur de 38,5 N y al oeste de 12 E solo hay mar y Africa.
const enZona = (la, lo) => !(la < 38.5 && lo < 12);

const tipoDe = (tags = {}) => (tags.highway === "services" ? "services" : tags.highway === "rest_area" ? "rest_area" : "parking");

const normalize = (elements) => {
  const places = elements
    .map((el) => {
      const la = el.lat ?? el.center?.lat;
      const lo = el.lon ?? el.center?.lon;
      if (la == null || lo == null || !enZona(la, lo)) return null;
      const name = (el.tags?.name ?? el.tags?.brand ?? el.tags?.operator ?? "").trim();
      return { t: tipoDe(el.tags), n: name || null, la: Number(la.toFixed(5)), lo: Number(lo.toFixed(5)) };
    })
    .filter(Boolean)
    .sort((p, q) => PRIORIDAD[p.t] - PRIORIDAD[q.t] || Number(Boolean(q.n)) - Number(Boolean(p.n)));
  const unique = [];
  for (const p of places) if (!unique.some((u) => Math.abs(u.la - p.la) < 0.01 && meters(u, p) < DUPLICADO_M)) unique.push(p);
  return unique;
};

const crudoIndex = process.argv.indexOf("--crudo");
const elements = crudoIndex >= 0 ? JSON.parse(readFileSync(process.argv[crudoIndex + 1], "utf8")) : await download();
const places = normalize(elements);
writeFileSync(FILE, `${JSON.stringify(places)}\n`);
const count = (t) => places.filter((p) => p.t === t).length;
console.log(`${places.length} sitios (${count("services")} areas de servicio, ${count("rest_area")} de descanso, ${count("parking")} parkings de camiones) -> ${FILE}`);
