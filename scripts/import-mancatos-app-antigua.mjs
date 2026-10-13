// Importa a la app los mancato pagamento de la app antigua de Gamonal Driver (Excel exportado de Peajes/Multas, pasado a CSV con ";"), uno por
// numero, vinculados a su chofer, vehiculo y servicio. Mismas reglas que import-mancatos-appsheet.mjs (solo 2026, numeros nunca repetidos,
// choferes/vehiculos que faltan se crean, los de la empresa van al perfil "Gamonal Trasporti").
//
//   node scripts/import-mancatos-app-antigua.mjs <archivo.csv>                -> informe SIN escribir nada en la base
//   node scripts/import-mancatos-app-antigua.mjs <archivo.csv> --aplicar      -> sube a la base
//   node scripts/import-mancatos-app-antigua.mjs --revertir <numeros.txt>     -> borra los que subio una corrida
//
// Columnas del CSV: Linea, Nº Mancato, Fecha, Hora, Fecha subida, Fecha límite pago, Monto (€), Autista, Targa, Estado, Link de pago, Cliente,
// Spedizione, Origen, Pagado por chofer, Comentarios (fechas como d/m/aaaa).
//
// Lo que esa app no trae se completa asi (y queda anotado en los comentarios del mancato):
//  - Sin targa: se usa la que el chofer escribio en los comentarios; si no hay, el vehiculo del unico servicio del chofer a esa hora/dia.
//  - Sin hora de transito: se usa la hora en que el chofer subio el aviso (si fue el mismo dia); si no, el unico servicio de ese dia.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { evaluateMatch, serviceWindow } from "../src/services/mancatoMatching.service.js";
import { romeLocalToDate } from "../src/utils/romeTime.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const REVERT = args.includes("--revertir");
const file = args.find((a) => !a.startsWith("--"));
const OUT_DIR = join(homedir(), "Downloads");
const DAY = 24 * 60 * 60 * 1000;

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
  return body.map((r) => Object.fromEntries(names.map((n, k) => [n, (r[k] ?? "").trim()])));
};
const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// ---- normalizaciones ----------------------------------------------------------------------------------------------------------------
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const targaOf = (s) => s.replace(/\s+/g, "").toUpperCase();
const TARGA_RE = /\b[A-Z]{2}\d{3}[A-Z]{2}\b/;
const dayOf = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s.trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
};
const hhmmOf = (s) => {
  const m = /(\d{1,2}):(\d{2})\s*$/.exec(s.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
const dayDate = (day) => new Date(`${day}T00:00:00.000Z`);
const romeDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(date);

const cleanNumero = (raw) => {
  const n = raw.replace(/^[‘’'"`\s]+/, "").replace(/[-\s]+$/, "").toUpperCase();
  if (/^\d{8,12}$/.test(n)) return n;
  if (/^\d{8,12}-\d{1,2}$/.test(n)) return n;
  if (/^\d{3,8}\/\d{4}$/.test(n)) return n;
  if (/^[0-9A-Z]{8,16}$/.test(n) && (n.match(/\d/g) ?? []).length >= 6) return n;
  return null;
};
const cleanMonto = (raw) => {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, "") : s.replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000000 ? Math.round(n * 100) / 100 : null;
};
// "www. autostrade. it", "wwwautostrade.it", "www itpspa.it" -> "www.autostrade.it"
const cleanSitio = (raw) => {
  const s = raw.trim().toLowerCase().replace(/\s*\.\s*/g, ".").replace(/\s+/g, ".");
  if (!s) return null;
  return s.replace(/^www(?=[a-z])/, "www.");
};

const ESTADOS = {
  PAGADO: { pagado: true },
  PENDIENTE: { pagado: false },
  OBSERVADO: { pagado: false, nota: "En observación en la app antigua" },
};

// ---- choferes: por nombre (sin tildes ni mayusculas; tolera una letra de error en el apellido) ------------------------------------------
const edit1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};
const buildDriverLookup = (users) => {
  const entries = users.map((u) => ({ id: u.id, full: fold(`${u.nombre} ${u.apellido}`), first: fold(u.nombre).split(" ")[0], last: fold(u.apellido).split(" ").at(-1), activo: u.estado === "ACTIVO" }));
  return (name) => {
    const full = fold(name) || "GAMONAL TRASPORTI";
    const exact = entries.filter((e) => e.full === full);
    if (exact.length) return (exact.find((e) => e.activo) ?? exact[0]).id;
    const [first, ...rest] = full.split(" ");
    const last = rest.at(-1);
    if (!last) return null;
    const loose = entries.filter((e) => e.first === first && edit1(e.last, last));
    if (loose.length === 1) return loose[0].id;
    // "MOISES CHAVEZ GARCIA" -> el usuario "Moises Chavez" (todas las palabras de su nombre estan en el nombre completo).
    const words = new Set(full.split(" "));
    const subset = entries.filter((e) => e.full.split(" ").length >= 2 && e.full.split(" ").every((w) => words.has(w)));
    if (subset.length === 1) return subset[0].id;
    // "Daniel Aranda" -> "Dany Aranda": el unico usuario con ese apellido y un nombre que empieza igual.
    const alias = entries.filter((e) => e.last === last && e.first.slice(0, 3) === first.slice(0, 3));
    return alias.length === 1 ? alias[0].id : null;
  };
};

// ---- revertir -------------------------------------------------------------------------------------------------------------------------
if (REVERT) {
  const list = readFileSync(file ?? args[args.indexOf("--revertir") + 1], "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const { count } = await prisma.mancatoPagamento.deleteMany({ where: { numero: { in: list } } });
  console.log(`Borrados ${count} mancatos de la lista (${list.length} numeros).`);
  await prisma.$disconnect();
  process.exit(0);
}

if (!file || !existsSync(file)) {
  console.error("Uso: node scripts/import-mancatos-app-antigua.mjs <archivo.csv> [--aplicar]");
  process.exit(1);
}

// ---- lectura de la base (una sola vez) ------------------------------------------------------------------------------------------------
const csv = parseCsv(readFileSync(file, "utf8"));
const [users, vehicles, existing, services] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, estado: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true } }),
  prisma.mancatoPagamento.findMany({ select: { numero: true } }),
  prisma.record.findMany({
    where: {
      servicioOrigenId: null,
      estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] },
      OR: [{ fechaRetiro: { gte: new Date("2026-07-20") } }, { fechaServicio: { gte: new Date("2026-07-20") } }],
    },
    select: {
      id: true, codigo: true, estado: true, destinazione: true, driverId: true, vehicleId: true, fechaServicio: true, fechaRetiro: true, eta: true,
      rutaDuracionMin: true, compactadoId: true, compactadoOrden: true,
    },
  }),
]);
const vehicleByTarga = new Map(vehicles.map((v) => [targaOf(v.targa), v.id]));
const targaById = new Map(vehicles.map((v) => [v.id, v.targa]));
const existingNumeros = new Set(existing.map((m) => m.numero));
const driverId = buildDriverLookup(users);
const servicesByVehicle = new Map();
const servicesByDriver = new Map();
const push = (map, key, value) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};
services.forEach((s) => {
  push(servicesByVehicle, s.vehicleId, s);
  push(servicesByDriver, s.driverId, s);
});

const serviceDay = (s) => romeDay(s.fechaRetiro ?? s.fechaServicio);
const candidatesFor = (vehicleId, t) =>
  (servicesByVehicle.get(vehicleId) ?? []).filter((s) => {
    const inWindow = (d) => d && d.getTime() >= t - 5 * DAY && d.getTime() <= t + 1 * DAY;
    return inWindow(s.fechaRetiro) || inWindow(s.fechaServicio);
  });
// Servicios (un viaje compacto cuenta como uno) de una lista en un dia dado.
const ofDay = (list, day) => {
  const seen = new Set();
  return (list ?? []).filter((s) => {
    if (serviceDay(s) !== day) return false;
    const key = s.compactadoId ?? s.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const distinct = (list, key) => [...new Set(list.map(key).filter(Boolean))];

// ---- armado de cada fila --------------------------------------------------------------------------------------------------------------
const rejected = [];
const reject = (row, motivo) => rejected.push({ linea: row.Linea, numero: row["Nº Mancato"], estado: row.Estado, monto: row["Monto (€)"], chofer: row.Autista, targa: row.Targa, fecha: row.Fecha, motivo });

const prepared = [];
for (const row of csv) {
  const numeroOriginal = row["Nº Mancato"];
  let numero = cleanNumero(numeroOriginal);
  const sinNumero = !numero;
  if (sinNumero) numero = `SIN-NUMERO-AA-${row.Linea}`;
  let costo = cleanMonto(row["Monto (€)"]);
  const sinMonto = costo == null;
  if (sinMonto) costo = 0;

  const fechaDay = dayOf(row.Fecha);
  if (!fechaDay) {
    reject(row, "Sin fecha de transito");
    continue;
  }
  if (!fechaDay.startsWith("2026")) {
    reject(row, `No es de 2026 (fecha ${row.Fecha})`);
    continue;
  }
  const estado = ESTADOS[fold(row.Estado)];
  if (!estado) {
    reject(row, `Estado desconocido: ${row.Estado}`);
    continue;
  }
  const limiteRaw = dayOf(row["Fecha límite pago"]);
  const limiteValido = limiteRaw && limiteRaw >= fechaDay && limiteRaw <= new Date(dayDate(fechaDay).getTime() + 90 * DAY).toISOString().slice(0, 10);
  const limiteDay = limiteValido ? limiteRaw : new Date(dayDate(fechaDay).getTime() + 15 * DAY).toISOString().slice(0, 10);

  const horaRaw = hhmmOf(row.Hora);
  const hora = horaRaw && horaRaw !== "00:00" ? horaRaw : null;
  const subidoDay = dayOf(row["Fecha subida"]);
  const subidoHhmm = hhmmOf(row["Fecha subida"]);
  const createdAt = romeLocalToDate(subidoDay ?? fechaDay, subidoHhmm ?? "12:00");
  const fechaHoraTransito = hora ? romeLocalToDate(fechaDay, hora) : null;
  // Sin hora de transito: el chofer suele subir el aviso al pasar, asi que la hora de la subida (del mismo dia) sirve para asignarlo.
  const horaAprox = !hora && subidoDay === fechaDay && subidoHhmm ? romeLocalToDate(fechaDay, subidoHhmm) : null;

  // Vehiculo: la columna Targa; si no la hay, una targa escrita en los comentarios ("TARGA real: FB390PR").
  // Muchos comentarios solo repiten el numero y la pagina de pago, que ya estan en sus propios campos: no se copian.
  const looksLikeUrl = (w) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(w);
  const comentarioOriginal = row.Comentarios.split(/\s+/).filter((w) => w && w !== numero && w !== numeroOriginal && !looksLikeUrl(w)).join(" ");
  const targaCol = targaOf(row.Targa);
  const targaComentario = TARGA_RE.exec(comentarioOriginal.toUpperCase().replace(/\s+/g, " "))?.[0] ?? null;
  let targa = targaCol;
  let vehicleId = vehicleByTarga.get(targaCol) ?? null;
  let targaNota = null;
  if (!vehicleId && targaComentario && vehicleByTarga.has(targaComentario)) {
    targa = targaComentario;
    vehicleId = vehicleByTarga.get(targaComentario);
    targaNota = `Targa tomada de los comentarios: ${targaComentario}`;
  } else if (!targa && targaComentario) {
    targa = targaComentario;
    targaNota = `Targa tomada de los comentarios: ${targaComentario}`;
  }
  if (!targa) targa = "SIN TARGA";

  const chofer = row.Autista;
  const choferId = driverId(chofer);
  const sitioWeb = cleanSitio(row["Link de pago"]);

  const comentarios = [
    "Importado de la app antigua",
    `Estado: ${row.Estado.trim()}${estado.nota ? ` (${estado.nota})` : ""}`,
    limiteValido ? null : `Limite de pago invalido (${row["Fecha límite pago"] || "vacio"}): se usa fecha + 15 dias`,
    sinNumero ? `Sin numero de verbale en la app antigua` : null,
    sinMonto ? `Sin monto en la app antigua` : null,
    row.Cliente ? `Cliente: ${row.Cliente}` : null,
    row.Spedizione ? `Servicio: ${row.Spedizione}` : null,
    row.Origen ? `Origen: ${row.Origen}` : null,
    row["Pagado por chofer"] === "Sí" ? "Pagado por el chofer" : null,
    !choferId && chofer ? `Chofer (app antigua): ${chofer}` : null,
    targaNota,
    comentarioOriginal ? `Comentarios: ${comentarioOriginal}` : null,
  ].filter(Boolean).join(" · ");

  prepared.push({
    _linea: row.Linea,
    _mes: fechaDay.slice(0, 7),
    _fechaDay: fechaDay,
    _horaAprox: horaAprox,
    _targaNoFlota: !vehicleId && Boolean(targa) && targa !== "SIN TARGA",
    numero,
    targa,
    vehicleId,
    driverId: choferId,
    fecha: dayDate(fechaDay),
    fechaHoraTransito,
    fechaVencimiento: dayDate(limiteDay),
    costo,
    sitioWeb,
    comentarios,
    pagado: estado.pagado,
    pagadoAt: null,
    fueraDePlazo: createdAt.getTime() > dayDate(limiteDay).getTime() + DAY,
    createdAt,
  });
}

// ---- numeros repetidos: dentro del archivo y contra lo que ya hay en la base ------------------------------------------------------------
const seen = new Map();
const unique = [];
let yaExistian = 0;
for (const m of prepared) {
  if (existingNumeros.has(m.numero)) {
    yaExistian += 1;
    continue;
  }
  if (seen.has(m.numero)) {
    const first = seen.get(m.numero);
    rejected.push({ linea: m._linea, numero: m.numero, estado: "", monto: m.costo, chofer: "", targa: m.targa, fecha: m._fechaDay, motivo: `Numero repetido en el archivo (ya esta la linea ${first._linea})` });
    continue;
  }
  seen.set(m.numero, m);
  unique.push(m);
}

// ---- orden cronologico y cruce con servicios --------------------------------------------------------------------------------------------
unique.sort((a, b) => a.fecha - b.fecha || (a.fechaHoraTransito ?? 0) - (b.fechaHoraTransito ?? 0) || a.createdAt - b.createdAt);

const stats = { auto: 0, enEspera: 0, porHoraSubida: 0, porDia: 0, porChofer: 0, vehiculoDeduc: 0, sinVehiculo: 0 };
const notas = [];
for (const m of unique) {
  const transitAt = m.fechaHoraTransito ?? m._horaAprox;
  const driverServices = servicesByDriver.get(m.driverId) ?? [];

  // Sin vehiculo conocido: el del unico servicio del chofer a esa hora (o ese dia).
  if (!m.vehicleId && m.driverId && !m._targaNoFlota) {
    const pool = transitAt
      ? driverServices.filter((s) => {
          const w = serviceWindow(s);
          return w.start - 45 * 60 * 1000 <= transitAt.getTime() && transitAt.getTime() <= w.returnEnd;
        })
      : ofDay(driverServices, m._fechaDay);
    const vehs = distinct(pool, (s) => s.vehicleId);
    if (vehs.length === 1) {
      m.vehicleId = vehs[0];
      m.targa = targaById.get(vehs[0]);
      m.comentarios += ` · Vehiculo ${m.targa} deducido del servicio del chofer ${transitAt ? "a esa hora" : "ese dia"} (la app antigua no traia targa)`;
      stats.vehiculoDeduc += 1;
    }
  }

  // Ultimo recurso: el chofer hizo un solo servicio ese dia (aunque sea con otro vehiculo o el aviso no traiga targa): se sugiere ese.
  const driverDay = () => (m.driverId ? ofDay(driverServices, m._fechaDay) : []);
  const bySoloServicioDelChofer = (motivo) => {
    const only = driverDay();
    if (only.length !== 1) return null;
    stats.porChofer += 1;
    return { recordId: only[0].id, asignacion: "SUGERIDO", tramo: null, asignacionMotivo: `${motivo} El chofer hizo un solo servicio ese dia (${only[0].codigo}).`, _vehicleId: only[0].vehicleId };
  };
  if (!m.vehicleId) {
    stats.sinVehiculo += 1;
    const result = !m._targaNoFlota || m.targa === "SIN TARGA" ? bySoloServicioDelChofer("El aviso no trae targa.") : null;
    if (result) {
      const { _vehicleId, ...rest } = result;
      Object.assign(m, rest);
      if (targaById.has(_vehicleId)) {
        m.vehicleId = _vehicleId;
        m.targa = targaById.get(_vehicleId);
        m.comentarios += ` · Vehiculo ${m.targa} tomado del servicio del chofer (la app antigua no traia targa)`;
      }
    } else {
      Object.assign(m, { recordId: null, asignacion: "EN_ESPERA", tramo: null, asignacionMotivo: m.targa === "SIN TARGA" ? "El aviso no trae targa y no se pudo deducir el vehiculo." : "La targa no esta registrada en Vehiculos." });
    }
  } else {
    let result = null;
    if (m.fechaHoraTransito) {
      result = evaluateMatch({
        transitAt: m.fechaHoraTransito,
        driverId: m.driverId,
        candidates: candidatesFor(m.vehicleId, m.fechaHoraTransito.getTime()).map((s) => ({ ...s, client: null, driver: null })),
        opts: { viajes: true, directo: true },
      });
    } else if (m._horaAprox) {
      // La hora de la subida es mas tarde que el transito: solo sirve si cae dentro de un servicio; si no, se busca por dia.
      const r = evaluateMatch({
        transitAt: m._horaAprox,
        driverId: m.driverId,
        candidates: candidatesFor(m.vehicleId, m._horaAprox.getTime()).map((s) => ({ ...s, client: null, driver: null })),
        opts: { viajes: true, directo: true },
      });
      if (r.recordId) {
        result = { ...r, asignacionMotivo: `${r.asignacionMotivo} La hora es la de la subida del aviso (la app antigua no traia hora de transito).` };
        stats.porHoraSubida += 1;
      }
    }
    if (!result?.recordId) {
      // Por dia: los servicios del vehiculo ese dia; si hay varios, los del chofer; si sigue habiendo varios, el ultimo que ya habia salido
      // cuando se subio el aviso (queda como SUGERIDO para que la oficina lo confirme).
      const pool = ofDay(servicesByVehicle.get(m.vehicleId), m._fechaDay);
      const mine = m.driverId ? pool.filter((s) => s.driverId === m.driverId) : [];
      const base = mine.length ? mine : pool;
      let pick = null;
      let sugerido = false;
      let motivo;
      if (base.length === 1) {
        pick = base[0];
        motivo = `${m.fechaHoraTransito ? "No cae dentro de la ventana de ningun servicio" : "Sin hora de transito"}: ${mine.length ? "es el unico servicio del chofer con ese vehiculo ese dia" : "el vehiculo hizo un solo servicio ese dia"} (${pick.codigo}).`;
      } else if (base.length > 1) {
        const limit = (m.fechaHoraTransito ?? m._horaAprox)?.getTime();
        const before = limit ? base.filter((s) => serviceWindow(s).start - 45 * 60 * 1000 <= limit).sort((a, b) => serviceWindow(b).start - serviceWindow(a).start) : [];
        if (before.length) {
          pick = before[0];
          sugerido = true;
          motivo = `${m.fechaHoraTransito ? "No cae dentro de la ventana de ningun servicio" : "Sin hora de transito"}: el vehiculo hizo ${base.length} servicios ese dia; se sugiere ${pick.codigo}, el ultimo que ya habia salido.`;
        } else {
          motivo = `${m.fechaHoraTransito ? "No cae dentro de la ventana de ningun servicio" : "Sin hora de transito"} y el vehiculo hizo ${base.length} servicios ese dia.`;
        }
      } else {
        const alt = bySoloServicioDelChofer("El vehiculo del aviso no tiene servicios ese dia.");
        if (alt) {
          pick = { id: alt.recordId };
          sugerido = true;
          motivo = alt.asignacionMotivo;
        } else motivo = result?.asignacionMotivo ?? "Sin hora de transito y el vehiculo no tiene servicios ese dia.";
      }
      if (pick) {
        result = { recordId: pick.id, asignacion: sugerido ? "SUGERIDO" : "AUTO", tramo: null, asignacionMotivo: motivo };
        stats.porDia += 1;
      } else {
        result = { recordId: null, asignacion: "EN_ESPERA", tramo: null, asignacionMotivo: motivo };
      }
    }
    Object.assign(m, result);
  }
  if (m.recordId) stats.auto += 1;
  else stats.enEspera += 1;
}

// ---- informe ----------------------------------------------------------------------------------------------------------------------------
const byMonth = new Map();
unique.forEach((m) => byMonth.set(m._mes, [...(byMonth.get(m._mes) ?? []), m]));
const rejectedByReason = new Map();
rejected.forEach((r) => {
  const k = r.motivo.replace(/\(ya esta la linea \d+\)/, "");
  rejectedByReason.set(k, (rejectedByReason.get(k) ?? 0) + 1);
});
const sumOf = (list) => Math.round(list.reduce((s, m) => s + m.costo, 0) * 100) / 100;
const unmatchedDrivers = new Map();
csv.forEach((r) => {
  if (r.Autista && !driverId(r.Autista)) unmatchedDrivers.set(r.Autista, (unmatchedDrivers.get(r.Autista) ?? 0) + 1);
});
const sinVehiculoPorMotivo = new Map();
unique.filter((m) => !m.vehicleId).forEach((m) => sinVehiculoPorMotivo.set(m.targa, (sinVehiculoPorMotivo.get(m.targa) ?? 0) + 1));

console.log(`\nArchivo: ${csv.length} filas`);
console.log(`A subir: ${unique.length} (${sumOf(unique).toFixed(2)} EUR)  |  Ya estaban en la app: ${yaExistian}  |  No se suben: ${rejected.length}`);
console.log("No se suben, por motivo:", Object.fromEntries(rejectedByReason));
console.log("\nPor mes (fecha del transito):");
[...byMonth.entries()].sort().forEach(([mes, list]) => console.log(`  ${mes}: ${String(list.length).padStart(4)} mancatos · ${sumOf(list).toFixed(2)} EUR · pagados ${list.filter((m) => m.pagado).length}`));
console.log(`\nVinculos: chofer ${unique.filter((m) => m.driverId).length}/${unique.length} · vehiculo ${unique.filter((m) => m.vehicleId).length}/${unique.length} (deducidos del servicio del chofer: ${stats.vehiculoDeduc})`);
console.log(`Cruce con servicios: asignados ${stats.auto} (con hora de la subida: ${stats.porHoraSubida}, por dia: ${stats.porDia}, por el unico servicio del chofer: ${stats.porChofer}) · sin servicio ${stats.enEspera}`);
console.log("Sin vehiculo, por targa:", Object.fromEntries(sinVehiculoPorMotivo));
console.log("Choferes sin usuario en la app (filas):", Object.fromEntries(unmatchedDrivers));

console.log("\nEjemplos:");
[unique[0], unique[Math.floor(unique.length / 2)], unique.find((m) => m.asignacion === "SUGERIDO"), unique.at(-1)].filter(Boolean).forEach((m) => console.log(`  ${m.numero} | ${m._fechaDay} ${m.fechaHoraTransito?.toISOString() ?? "sin hora"} | ${m.targa} | ${m.costo} | ${m.sitioWeb} | ${m.asignacion} ${m.recordId ? "-> servicio" : ""}\n    ${m.comentarios}\n    ${m.asignacionMotivo}`));

const outRows = unique.map((m) => [m.numero, m._fechaDay, m.targa, m.costo, m.pagado ? "PAGADO" : "NO PAGADO", m.driverId ? "" : "sin chofer", m.vehicleId ? "" : "sin vehiculo", m.recordId ?? "", m.asignacion, m.asignacionMotivo]);
writeFileSync(join(OUT_DIR, "mancatos-app-antigua-cruce.csv"), ["numero;fecha;targa;monto;estado;chofer;vehiculo;record;asignacion;motivo", ...outRows.map((r) => r.map(csvEscape).join(";"))].join("\n"));
writeFileSync(
  join(OUT_DIR, "mancatos-no-importados.csv"),
  ["linea;numero;estado;monto;chofer;targa;fecha;motivo", ...rejected.map((r) => [r.linea, r.numero, r.estado, r.monto, r.chofer, r.targa, r.fecha, r.motivo].map(csvEscape).join(";"))].join("\n")
);
console.log(`\nDetalle del cruce: ${join(OUT_DIR, "mancatos-app-antigua-cruce.csv")}  |  Lo que NO se sube: ${join(OUT_DIR, "mancatos-no-importados.csv")}`);

if (!APPLY) {
  console.log("\n(Informe: no se escribio nada en la base. Para subir: agrega --aplicar)");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- subida, mes por mes ----------------------------------------------------------------------------------------------------------------
const uploaded = [];
for (const [mes, list] of [...byMonth.entries()].sort()) {
  const data = list.map(({ _linea, _mes, _fechaDay, _horaAprox, _targaNoFlota, ...row }) => row);
  const { count } = await prisma.mancatoPagamento.createMany({ data, skipDuplicates: true });
  uploaded.push(...list.map((m) => m.numero));
  console.log(`  ${mes}: subidos ${count} de ${data.length}`);
}
writeFileSync(join(OUT_DIR, "mancatos-app-antigua-numeros.txt"), uploaded.join("\n"));
console.log(`\nListo: ${uploaded.length} mancatos. Lista de numeros (para revertir): ${join(OUT_DIR, "mancatos-app-antigua-numeros.txt")}`);
console.log(`Total en la app ahora: ${await prisma.mancatoPagamento.count()}`);
await prisma.$disconnect();
