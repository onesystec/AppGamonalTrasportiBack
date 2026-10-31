// Descarga UNA vez los sitios donde parar de Italia de OpenStreetMap (areas de servicio highway=services, areas de descanso
// highway=rest_area y parkings aptos para camiones amenity=parking + hgv=yes/designated) y los guarda en data/areas-parada-italia.json.
// Es lo que usa el "punto de encuentro" del Mapa: asi no depende de ningun servicio externo al buscar.
//
//   node scripts/importar-areas-parada-osm.mjs                   -> descarga de OpenStreetMap (Overpass, por cuadriculas) y regenera el archivo
//   node scripts/importar-areas-parada-osm.mjs --crudo ruta.json [--cadenas otra.json]
//                                                                -> regenera el archivo desde descargas ya hechas (listas de elementos de Overpass)
// Ademas descarga los restaurantes de las concesionarias de autopista (Autogrill, Chef Express, Sarni, MyChef, Ristop): un area con una de ellas
// a menos de 500 m queda marcada con "m" (la marca), que es lo que confirma que es un area de servicio de autopista de verdad.
// Quedan fuera los sitios que OpenStreetMap marca como no publicos o de pago, y los tramos de calle. Datos de voluntarios: con repetirlo una vez al ano alcanza. Datos (c) colaboradores de OpenStreetMap, licencia ODbL.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../data/areas-parada-italia.json");
const SERVERS = ["https://overpass.openstreetmap.fr/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
// Consultas simples (etiqueta exacta): las que usan expresiones regulares tardan demasiado y los servidores publicos las cortan.
const FILTERS = ['["highway"="services"]', '["highway"="rest_area"]', '["amenity"="parking"]["hgv"="yes"]', '["amenity"="parking"]["hgv"="designated"]'];
// Concesionarias de areas de servicio de autopista. Se buscan por marca, operador o nombre exactos.
const CADENAS = ["Autogrill", "Chef Express", "Sarni", "MyChef", "Ristop"];
const CADENA_CERCA_M = 500;
const STEP = 1.5;
const BOUNDS = { south: 36, north: 47.2, west: 6.4, east: 18.8 };
const CONCURRENCY = 4;
// Dos sitios a menos de esto son el mismo (la gasolinera de un area de servicio es el area de servicio): queda el mas importante.
const DUPLICADO_M = 400;
const PRIORIDAD = { services: 0, rest_area: 1, parking: 2 };
// No son sitios publicos: acceso privado, solo clientes, con permiso, prohibido o solo para reparto/destino.
const ACCESO_NO_PUBLICO = new Set(["no", "private", "customers", "permit", "delivery", "destination", "members", "residents"]);
// Tramos de calle donde se puede dejar el vehiculo, no parkings; y capacidad (si la dice) con la que no cabe un camion.
const PARKING_DE_CALLE = new Set(["street_side", "lane", "on_kerb", "half_on_kerb", "shoulder"]);
const CAPACIDAD_MINIMA = 8;

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

const downloadCadenas = async () => {
  const found = new Map();
  for (const chain of CADENAS)
    for (const key of ["brand", "operator", "name"])
      for (const el of await query(BOUNDS.south, BOUNDS.west, BOUNDS.north, BOUNDS.east, `["${key}"="${chain}"]`)) found.set(`${el.type}${el.id}`, el);
  return [...found.values()];
};

// A que concesionaria pertenece un restaurante (marca, operador o nombre), o null.
const cadenaDe = (tags = {}) => {
  const texto = [tags.brand, tags.operator, tags.name].filter(Boolean).map((v) => v.toLowerCase());
  return CADENAS.find((c) => texto.some((t) => t === c.toLowerCase() || t.startsWith(`${c.toLowerCase()} `))) ?? null;
};

// La cuadricula tambien coge el norte de Africa (Argelia, Tunez): al sur de 38,5 N y al oeste de 12 E solo hay mar y Africa.
const enZona = (la, lo) => !(la < 38.5 && lo < 12);

const tipoDe = (tags = {}) => (tags.highway === "services" ? "services" : tags.highway === "rest_area" ? "rest_area" : "parking");

// Se descarta lo que OpenStreetMap dice que no es publico, de pago o demasiado pequeno. Los parkings guardan "q": "g" si OpenStreetMap dice que
// son gratuitos (fee=no) y nada si no dice nada del precio (el front los marca "sin datos"). Las areas de servicio y de descanso son de autopista:
// publicas por definicion, sin dato de precio.
const aceptado = (tags = {}) => {
  if (ACCESO_NO_PUBLICO.has(tags.access)) return false;
  if (tags.fee === "yes") return false;
  if (tipoDe(tags) !== "parking") return true;
  if (PARKING_DE_CALLE.has(tags.parking)) return false;
  const capacidad = Number.parseInt(tags["capacity:hgv"] ?? tags.capacity, 10);
  return !(capacidad < CAPACIDAD_MINIMA);
};

const normalize = (elements, cadenas) => {
  const places = elements
    .map((el) => {
      const la = el.lat ?? el.center?.lat;
      const lo = el.lon ?? el.center?.lon;
      if (la == null || lo == null || !enZona(la, lo) || !aceptado(el.tags)) return null;
      const name = (el.tags?.name ?? el.tags?.brand ?? el.tags?.operator ?? "").trim();
      const t = tipoDe(el.tags);
      return { t, n: name || null, la: Number(la.toFixed(5)), lo: Number(lo.toFixed(5)), ...(t === "parking" && el.tags.fee === "no" ? { q: "g" } : {}) };
    })
    .filter(Boolean)
    .sort((p, q) => PRIORIDAD[p.t] - PRIORIDAD[q.t] || Number(Boolean(q.n)) - Number(Boolean(p.n)));
  const restaurantes = cadenas
    .map((el) => {
      const la = el.lat ?? el.center?.lat;
      const lo = el.lon ?? el.center?.lon;
      const m = cadenaDe(el.tags);
      if (la == null || lo == null || !m || !enZona(la, lo)) return null;
      return { m, la: Number(la.toFixed(5)), lo: Number(lo.toFixed(5)), tags: el.tags };
    })
    .filter(Boolean);
  const cerca = (p) => restaurantes.find((r) => Math.abs(r.la - p.la) < 0.01 && meters(r, p) <= CADENA_CERCA_M);

  // Un Autogrill (o similar) sin ningun area mapeada a su lado tambien es un area de servicio de autopista: se agrega solo si es un restaurante
  // llamado como la cadena (no un bar, un cafe ni uno de estacion o aeropuerto con otro nombre).
  const sueltos = restaurantes
    .filter((r) => ["restaurant", "fast_food"].includes(r.tags.amenity) && r.tags.name?.toLowerCase().startsWith(r.m.toLowerCase()))
    .filter((r) => !places.some((p) => Math.abs(r.la - p.la) < 0.01 && meters(r, p) <= CADENA_CERCA_M))
    .map((r) => ({ t: "services", n: r.tags.name.trim(), la: r.la, lo: r.lo }));

  const unique = [];
  for (const p of [...places, ...sueltos]) if (!unique.some((u) => Math.abs(u.la - p.la) < 0.01 && meters(u, p) < DUPLICADO_M)) unique.push(p);
  // "m" = la concesionaria que confirma el area (solo areas de servicio y de descanso, no parkings).
  return unique.map((p) => {
    const r = p.t === "parking" ? null : cerca(p);
    return r ? { ...p, m: r.m } : p;
  });
};

const crudoIndex = process.argv.indexOf("--crudo");
const cadenasIndex = process.argv.indexOf("--cadenas");
const elements = crudoIndex >= 0 ? JSON.parse(readFileSync(process.argv[crudoIndex + 1], "utf8")) : await download();
const cadenas = cadenasIndex >= 0 ? JSON.parse(readFileSync(process.argv[cadenasIndex + 1], "utf8")) : await downloadCadenas();
const places = normalize(elements, cadenas);
writeFileSync(FILE, `${JSON.stringify(places)}\n`);
const count = (t) => places.filter((p) => p.t === t).length;
const gratis = places.filter((p) => p.q === "g").length;
const confirmadas = places.filter((p) => p.m).length;
console.log(
  `${places.length} sitios (${count("services")} areas de servicio, ${count("rest_area")} de descanso, ${count("parking")} parkings de camiones: ${gratis} gratuitos segun OpenStreetMap; ${confirmadas} con concesionaria confirmada) -> ${FILE}`
);
