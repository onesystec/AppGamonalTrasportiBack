// Importa a la app los mancato pagamento exportados de AppSheet (CSV con ";"), uno por numero, vinculados a sus choferes, vehiculos y
// servicios reales. Sube mes por mes (por la fecha del transito) y nunca repite un numero.
//
//   node scripts/import-mancatos-appsheet.mjs <archivo.csv>                   -> informe SIN escribir nada en la base
//   node scripts/import-mancatos-appsheet.mjs <archivo.csv> --aplicar         -> sube a la base, mes por mes
//   node scripts/import-mancatos-appsheet.mjs --revertir <numeros.txt>        -> borra los que subio una corrida (lista de numeros)
//
// Cuidado con el costo en Neon: se lee todo lo necesario de una vez (usuarios, vehiculos, numeros existentes, servicios de 2026) y se
// escribe con un createMany por mes, sin consultas por fila; el cruce con los servicios se hace en memoria.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { evaluateMatch } from "../src/services/mancatoMatching.service.js";
import { romeLocalToDate } from "../src/utils/romeTime.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--aplicar");
const REVERT = args.includes("--revertir");
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--excluir");
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
  return body.map((r, i) => ({ _linea: i + 2, ...Object.fromEntries(names.map((n, k) => [n, (r[k] ?? "").trim()])) }));
};

const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// ---- normalizaciones ----------------------------------------------------------------------------------------------------------------
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const targaOf = (s) => s.replace(/\s+/g, "").toUpperCase();

// "d/m/yyyy" -> "yyyy-mm-dd"
const dayOf = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s.trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
};
const hhmmOf = (s) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
const dayDate = (day) => new Date(`${day}T00:00:00.000Z`);

// Numero del aviso: solo digitos (8 o mas), digitos con sufijo "-1", codigos alfanumericos con muchos digitos o "332240/2026". Se
// limpian las comillas y guiones que sobran en los bordes. Lo demas (texto suelto, "Traghetto", "007") no es un numero real.
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
  // "1,073.84" (coma de miles) y "12,5" (coma decimal).
  const n = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, "") : s.replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000000 ? Math.round(n * 100) / 100 : null;
};

const ESTADOS = {
  PAGADO: { pagado: true },
  "PAGADO POR AUTISTA": { pagado: true, nota: "Pagado por el chofer" },
  "PAGO BONIFICO": { pagado: true, nota: "Pagado por bonifico (transferencia)" },
  "PAGO EN SOLLECITO": { pagado: true, nota: "Pagado en el sollecito" },
  "NO PAGADO": { pagado: false },
  VENCIDO: { pagado: false, vencido: true, nota: "Vencido en AppSheet" },
  "OBSERVACION": { pagado: false, nota: "En observación en AppSheet" },
};

const looksLikeUrl = (s) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s) && !/\s/.test(s);

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
    // Sin nombre o "GAMONAL TRASPORTI": el mancato es de la empresa (perfil "Gamonal Trasporti").
    const full = fold(name) || "GAMONAL TRASPORTI";
    const exact = entries.filter((e) => e.full === full);
    if (exact.length) return (exact.find((e) => e.activo) ?? exact[0]).id;
    const [first, ...rest] = full.split(" ");
    const last = rest.at(-1);
    if (!last) return null;
    const loose = entries.filter((e) => e.first === first && edit1(e.last, last));
    return loose.length === 1 ? loose[0].id : null;
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
  console.error("Uso: node scripts/import-mancatos-appsheet.mjs <archivo.csv> [--aplicar]");
  process.exit(1);
}

// ---- lectura de la base (una sola vez) ------------------------------------------------------------------------------------------------
let csv = parseCsv(readFileSync(file, "utf8"));
// --excluir <viejo.csv>: el archivo nuevo trae de nuevo todas las filas del anterior (y los numeros SIN-NUMERO-<linea> dependen de la linea), asi
// que se saltan las filas que ya estaban en ese archivo (mismo verbale, fecha, monto y targa) y solo se trabaja con las nuevas.
const excluirFile = args.includes("--excluir") ? args[args.indexOf("--excluir") + 1] : null;
if (excluirFile) {
  const rowKey = (r) => [r["VERBALE O SOLLECITO"], r["FECHA RECEPCIÓN"], r.MONTO, r.TARGA].join("|");
  const prev = new Map();
  parseCsv(readFileSync(excluirFile, "utf8")).forEach((r) => prev.set(rowKey(r), (prev.get(rowKey(r)) ?? 0) + 1));
  csv = csv.filter((r) => {
    const k = rowKey(r);
    if ((prev.get(k) ?? 0) > 0) {
      prev.set(k, prev.get(k) - 1);
      return false;
    }
    return true;
  });
  console.log(`Filas nuevas respecto de ${excluirFile}: ${csv.length}`);
}
const [users, vehicles, existing, services] = await Promise.all([
  prisma.user.findMany({ select: { id: true, nombre: true, apellido: true, estado: true } }),
  prisma.vehiculo.findMany({ select: { id: true, targa: true } }),
  prisma.mancatoPagamento.findMany({ select: { numero: true } }),
  prisma.record.findMany({
    where: {
      servicioOrigenId: null,
      estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] },
      OR: [{ fechaRetiro: { gte: new Date("2025-12-20") } }, { fechaServicio: { gte: new Date("2025-12-20") } }],
    },
    select: {
      id: true, codigo: true, estado: true, destinazione: true, driverId: true, vehicleId: true, fechaServicio: true, fechaRetiro: true, eta: true,
      rutaDuracionMin: true, compactadoId: true, compactadoOrden: true,
    },
  }),
]);
const vehicleByTarga = new Map(vehicles.map((v) => [targaOf(v.targa), v.id]));
const existingNumeros = new Set(existing.map((m) => m.numero));
const driverId = buildDriverLookup(users);
const servicesByVehicle = new Map();
services.forEach((s) => {
  if (!servicesByVehicle.has(s.vehicleId)) servicesByVehicle.set(s.vehicleId, []);
  servicesByVehicle.get(s.vehicleId).push(s);
});

// Servicios del vehiculo cerca del transito: la misma ventana que usa la app (5 dias antes, 1 despues).
const candidatesFor = (vehicleId, t) =>
  (servicesByVehicle.get(vehicleId) ?? []).filter((s) => {
    const inWindow = (d) => d && d.getTime() >= t - 5 * DAY && d.getTime() <= t + 1 * DAY;
    return inWindow(s.fechaRetiro) || inWindow(s.fechaServicio);
  });

// ---- armado de cada fila --------------------------------------------------------------------------------------------------------------
const rejected = [];
const reject = (row, motivo) => rejected.push({ linea: row._linea, numero: row["VERBALE O SOLLECITO"], estado: row.ESTADO, monto: row.MONTO, chofer: row["ID_ TRABAJADOR"], targa: row.TARGA, fecha: row["FECHA RECEPCIÓN"], motivo });

const prepared = [];
for (const row of csv) {
  // Un numero que no es real se rescata si se puede ("5453932369 / 5453932385", "50 80 70 27 06", caracteres invisibles); si no, el
  // mancato se sube igual con un numero propio ("SIN-NUMERO-<linea>") y el texto original queda en los comentarios.
  const numeroOriginal = row["VERBALE O SOLLECITO"];
  let numero = cleanNumero(numeroOriginal);
  let numeroRescatado = false;
  if (!numero) {
    const compact = numeroOriginal.split("/")[0].replace(/[\s\u200B-\u200F\u202A-\u202E\uFEFF]/g, "");
    numero = cleanNumero(compact);
    numeroRescatado = Boolean(numero);
  }
  const sinNumero = !numero;
  if (sinNumero) numero = `SIN-NUMERO-${row._linea}`;
  let costo = cleanMonto(row.MONTO);
  const sinMonto = costo == null;
  if (sinMonto) costo = 0;
  // Solo se guarda 2026. Si la fecha de recepcion esta vacia o tiene un error de año (p. ej. 2016) pero el aviso se creo en 2026, el chofer
  // se equivoco al escribirla: se usa el mismo dia con el año de la creacion (o, si no hay fecha, el dia de la creacion) y queda anotado.
  const creationDayRaw = dayOf(row["FECHA CREACIÓN"]);
  let fechaDay = dayOf(row["FECHA RECEPCIÓN"]);
  let fechaCorregida = null;
  if (creationDayRaw?.startsWith("2026") && (!fechaDay || fechaDay.startsWith("2016"))) {
    fechaCorregida = fechaDay ? `Fecha de recepcion corregida: AppSheet decia ${row["FECHA RECEPCIÓN"]}` : "Sin fecha de recepcion en AppSheet: se usa la fecha de creacion";
    fechaDay = fechaDay ? `2026${fechaDay.slice(4)}` : creationDayRaw;
  }
  if (!fechaDay) {
    reject(row, "Sin fecha de transito (FECHA RECEPCIÓN)");
    continue;
  }
  if (!fechaDay.startsWith("2026")) {
    reject(row, `No es de 2026 (fecha de recepcion ${row["FECHA RECEPCIÓN"]})`);
    continue;
  }
  const estadoKey = fold(row.ESTADO);
  const estado = ESTADOS[estadoKey];
  if (!estado) {
    reject(row, `Estado desconocido: ${row.ESTADO}`);
    continue;
  }
  // Un limite de pago que no tiene sentido (1970, otro año, antes del transito) se reemplaza por fecha + 15 dias.
  const limiteRaw = dayOf(row["FECHA LÍMITE DE PAGO"]);
  const limiteValido = limiteRaw && limiteRaw >= fechaDay && limiteRaw.startsWith("2026") || (limiteRaw && limiteRaw >= fechaDay && limiteRaw <= new Date(dayDate(fechaDay).getTime() + 90 * DAY).toISOString().slice(0, 10));
  const limiteDay = limiteValido ? limiteRaw : new Date(dayDate(fechaDay).getTime() + 15 * DAY).toISOString().slice(0, 10);
  // "00:00" es la hora que AppSheet pone cuando no hay hora.
  const hora = hhmmOf(row.HORA) === "00:00" ? null : hhmmOf(row.HORA);
  const targa = targaOf(row.TARGA) || "SIN TARGA";
  const vehicleId = vehicleByTarga.get(targa) ?? null;
  const chofer = row["ID_ TRABAJADOR"];
  const choferId = driverId(chofer);

  const creationDay = dayOf(row["FECHA CREACIÓN"]);
  const creationHhmm = hhmmOf(row["FECHA CREACIÓN"].split(" ")[1] ?? "") ?? "12:00";
  const createdAt = romeLocalToDate(creationDay ?? fechaDay, creationHhmm);
  const fechaHoraTransito = hora ? romeLocalToDate(fechaDay, hora) : null;

  const notaAutista = row["NOTA AUTISTA"];
  const comentarios = [
    "Importado de AppSheet",
    `Estado: ${row.ESTADO.trim()}${estado.nota ? ` (${estado.nota})` : ""}`,
    fechaCorregida,
    limiteValido ? null : `Limite de pago de AppSheet invalido (${row["FECHA LÍMITE DE PAGO"] || "vacio"}): se usa fecha + 15 dias`,
    sinNumero ? `Sin numero de verbale: en AppSheet decia "${numeroOriginal || "(vacio)"}"` : null,
    numeroRescatado ? `Numero original en AppSheet: ${numeroOriginal}` : null,
    sinMonto ? `Sin monto valido en AppSheet (${row.MONTO.trim() || "vacio"})` : null,
    row.MES ? `Mes AppSheet: ${row.MES}` : null,
    row.AREA ? `Área: ${row.AREA.trim()}` : null,
    row["PEAJE/SALIDA"] ? `Peaje/salida: ${row["PEAJE/SALIDA"]}` : null,
    !choferId && chofer ? `Chofer (AppSheet): ${chofer}` : null,
    !vehicleId && row.TARGA ? `Targa sin vehiculo en la app: ${row.TARGA}` : null,
    row.TIPO ? `Tipo: ${row.TIPO}` : null,
    row.COMENTARIOS ? `Comentarios: ${row.COMENTARIOS}` : null,
    notaAutista && !looksLikeUrl(notaAutista) ? `Nota del chofer: ${notaAutista}` : null,
  ].filter(Boolean).join(" · ");

  prepared.push({
    _linea: row._linea,
    _hora: Boolean(hora),
    _mes: fechaDay.slice(0, 7),
    numero,
    _rescatado: numeroRescatado,
    _linea0: row._linea,
    targa,
    vehicleId,
    driverId: choferId,
    fecha: dayDate(fechaDay),
    fechaHoraTransito,
    fechaVencimiento: dayDate(limiteDay),
    costo,
    sitioWeb: notaAutista && looksLikeUrl(notaAutista) ? notaAutista.toLowerCase() : null,
    comentarios,
    pagado: estado.pagado,
    pagadoAt: null,
    // Se cargo despues del plazo, o AppSheet ya lo tenia como vencido.
    fueraDePlazo: Boolean(estado.vencido) || createdAt.getTime() > dayDate(limiteDay).getTime() + DAY,
    createdAt,
  });
}

// ---- numeros repetidos: dentro del archivo y contra lo que ya hay en la base ------------------------------------------------------------
const seen = new Map();
const unique = [];
let yaExistian = 0;
for (const m of prepared) {
  if (m._rescatado && (existingNumeros.has(m.numero) || seen.has(m.numero))) {
    m.comentarios += ` · El numero ${m.numero} ya estaba usado: se sube con un numero propio`;
    m.numero = `SIN-NUMERO-${m._linea}`;
    m._rescatado = false;
  }
  if (existingNumeros.has(m.numero)) {
    yaExistian += 1;
    continue;
  }
  if (seen.has(m.numero)) {
    const first = seen.get(m.numero);
    rejected.push({ linea: m._linea, numero: m.numero, estado: "", monto: m.costo, chofer: "", targa: m.targa, fecha: m.fecha.toISOString().slice(0, 10), motivo: `Numero repetido en el archivo (ya esta la linea ${first._linea})` });
    continue;
  }
  seen.set(m.numero, m);
  unique.push(m);
}

// ---- orden cronologico y cruce con servicios --------------------------------------------------------------------------------------------
unique.sort((a, b) => a.fecha - b.fecha || (a.fechaHoraTransito ?? 0) - (b.fechaHoraTransito ?? 0) || a.createdAt - b.createdAt);

const stats = { auto: 0, enEspera: 0, sinHora: 0, sinVehiculo: 0 };
for (const m of unique) {
  if (m._mes < "2026-07") {
    // Los anteriores al 1 de julio de 2026 no se asignan a ningun servicio (ver ASIGNACION_DESDE en mancatoMatching.service.js).
    Object.assign(m, { recordId: null, asignacion: "EN_ESPERA", tramo: null, asignacionMotivo: "Anterior al 1 de julio de 2026: no se asigna a un servicio." });
  } else if (!m.fechaHoraTransito) {
    stats.sinHora += 1;
    Object.assign(m, { recordId: null, asignacion: "EN_ESPERA", tramo: null, asignacionMotivo: "Importado de AppSheet sin hora de transito: no se puede asignar a un servicio." });
  } else if (!m.vehicleId) {
    stats.sinVehiculo += 1;
    Object.assign(m, { recordId: null, asignacion: "EN_ESPERA", tramo: null, asignacionMotivo: "La targa no esta registrada en Vehiculos." });
  } else {
    const result = evaluateMatch({
      transitAt: m.fechaHoraTransito,
      driverId: m.driverId,
      candidates: candidatesFor(m.vehicleId, m.fechaHoraTransito.getTime()).map((s) => ({ ...s, client: null, driver: null })),
      opts: { viajes: true, directo: true },
    });
    Object.assign(m, result);
    if (result.recordId) stats.auto += 1;
    else stats.enEspera += 1;
  }
}

// ---- informe ----------------------------------------------------------------------------------------------------------------------------
const byMonth = new Map();
unique.forEach((m) => byMonth.set(m._mes, [...(byMonth.get(m._mes) ?? []), m]));
const rejectedByReason = new Map();
rejected.forEach((r) => rejectedByReason.set(r.motivo.replace(/\(ya esta la linea \d+\)/, ""), (rejectedByReason.get(r.motivo.replace(/\(ya esta la linea \d+\)/, "")) ?? 0) + 1));
const unmatchedTargas = [...new Set(unique.filter((m) => !m.vehicleId).map((m) => m.targa))];
const unmatchedDrivers = new Map();
csv.forEach((r) => {
  const name = r["ID_ TRABAJADOR"];
  if (name && !driverId(name)) unmatchedDrivers.set(name, (unmatchedDrivers.get(name) ?? 0) + 1);
});
const sumByMonth = (list) => Math.round(list.reduce((s, m) => s + m.costo, 0) * 100) / 100;

console.log(`\nArchivo: ${csv.length} filas`);
console.log(`A subir: ${unique.length}  |  Ya estaban en la app: ${yaExistian}  |  No se suben: ${rejected.length}`);
console.log("No se suben, por motivo:", Object.fromEntries(rejectedByReason));
console.log("Numeros repetidos en el archivo o ya en la app:", rejected.filter((r) => /repetido|ya existe/.test(r.motivo)).length);
console.log("\nPor mes (fecha del transito):");
[...byMonth.entries()].sort().forEach(([mes, list]) => console.log(`  ${mes}: ${String(list.length).padStart(4)} mancatos · ${sumByMonth(list).toFixed(2)} EUR · pagados ${list.filter((m) => m.pagado).length}`));
console.log(`\nVinculos: chofer ${unique.filter((m) => m.driverId).length}/${unique.length} · vehiculo ${unique.filter((m) => m.vehicleId).length}/${unique.length}`);
console.log(`Cruce con servicios: asignados a un servicio ${stats.auto} · sin servicio que concuerde ${stats.enEspera} · sin hora ${stats.sinHora} · sin vehiculo ${stats.sinVehiculo}`);
console.log("Targas sin vehiculo en la app:", unmatchedTargas);
console.log("Choferes sin usuario en la app (filas):", Object.fromEntries(unmatchedDrivers));

writeFileSync(
  join(OUT_DIR, "mancatos-no-importados.csv"),
  ["linea;numero;estado;monto;chofer;targa;fecha;motivo", ...rejected.map((r) => [r.linea, r.numero, r.estado, r.monto, r.chofer, r.targa, r.fecha, r.motivo].map(csvEscape).join(";"))].join("\n")
);
console.log(`\nLista de lo que NO se sube (con el motivo): ${join(OUT_DIR, "mancatos-no-importados.csv")}`);

if (!APPLY) {
  console.log("\n(Informe: no se escribio nada en la base. Para subir: agrega --aplicar)");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- subida, mes por mes ----------------------------------------------------------------------------------------------------------------
const uploaded = [];
for (const [mes, list] of [...byMonth.entries()].sort()) {
  const data = list.map(({ _linea, _linea0, _rescatado, _hora, _mes, ...row }) => row);
  const { count } = await prisma.mancatoPagamento.createMany({ data, skipDuplicates: true });
  uploaded.push(...list.map((m) => m.numero));
  console.log(`  ${mes}: subidos ${count} de ${data.length}`);
}
writeFileSync(join(OUT_DIR, "mancatos-importados-numeros.txt"), uploaded.join("\n"));
console.log(`\nListo: ${uploaded.length} mancatos. Lista de numeros (para revertir): ${join(OUT_DIR, "mancatos-importados-numeros.txt")}`);
console.log(`Total en la app ahora: ${await prisma.mancatoPagamento.count()}`);
await prisma.$disconnect();
