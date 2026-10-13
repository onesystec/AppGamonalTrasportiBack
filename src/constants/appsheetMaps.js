// Nombre de pestana y prefijo de origenExternoId de la planilla "APP GT 1.0" (ver
// googleSheets.service.js), mas los mapas de valores hoja <-> enum Prisma. Vive en un
// modulo sin dependencias (ni de record.service.js ni de appsheetSync.service.js) para
// que tanto la lectura (appsheetSync.service.js) como la escritura
// (appsheetWriteback.service.js, usada desde record.service.js) puedan importarlo sin
// generar un ciclo entre esos dos.
export const REGISTROS_TAB = "DHL CONSEGNAS";
export const ORIGEN_PREFIX = "appsheet:";

export const ESTADO_MAP = {
  CONSEGNATO: "CONSEGNATO",
  ENTREGADO: "CONSEGNATO",
  "IN CONSEGNA": "IN_CONSEGNA",
  "IN SOSPESO": "IN_SOSPESO",
  PENDIENTE: "IN_SOSPESO",
  RITIRATO: "RITIRATO",
  RETIRADO: "RITIRATO",
  ANNULLATO: "ANNULLATO",
  ANULADO: "ANNULLATO",
  RISCHEDULATO: "RISCHEDULATO",
  REPROGRAMADO: "RISCHEDULATO",
};

export const SPEDIZZIONE_MAP = {
  DHL: "DHL",
  "AB SERVICE": "AB_SERVICE",
  AB_SERVICE: "AB_SERVICE",
  "EXTRA PIAZZA": "EXTRA_PIAZZA",
  EXTRA_PIAZZA: "EXTRA_PIAZZA",
  "EXTRAS STEFANIA": "EXTRAS_STEFANIA",
  EXTRAS_STEFANIA: "EXTRAS_STEFANIA",
};

// Columna "ZONA" (a agregar en la planilla, hoy no existe) - solo aplica a filas
// EXTRA_PIAZZA.
export const ZONA_MAP = {
  MILANO: "MILANO",
  MILAN: "MILANO",
  ROMA: "ROMA",
  ROME: "ROMA",
};

// Primer match por valor de cada mapa, para tener una forma canonica al escribir de
// vuelta a la hoja (ej. IN_CONSEGNA -> "IN CONSEGNA", no "PENDIENTE" para IN_SOSPESO).
const reverseFirstMatch = (map) => {
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    if (!(value in out)) out[value] = key;
  }
  return out;
};

export const ESTADO_REVERSE = reverseFirstMatch(ESTADO_MAP);
export const SPEDIZZIONE_REVERSE = reverseFirstMatch(SPEDIZZIONE_MAP);
export const ZONA_REVERSE = reverseFirstMatch(ZONA_MAP);

const MESES_ES = [
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
];

// Columna "MES" de la hoja: "7. JULIO", "8. AGOSTO", etc, derivado del mes UTC de
// fechaServicio (mismo criterio que toSheetDate en appsheetWriteback.service.js).
export const getMesLabel = (value) => {
  const mes = new Date(value).getUTCMonth() + 1;
  return `${mes}. ${MESES_ES[mes - 1]}`;
};

// --- Conversion de horario para la columna ETA (hora de pared en Italia) -----------
//
// La planilla la maneja gente en Italia y siempre muestra/carga la hora "de pared"
// (Europe/Rome, CET/CEST segun la epoca del anio). La base guarda todo en UTC. DATA
// (solo fecha, sin hora) y fechaServicio ya son simetricos usando UTC "a secas" en
// toSheetDate/parseSheetDate (sin horario, un desfasaje de huso no cambia el dia en
// la practica) - no se tocan aca. Pero ETA SI lleva hora real, y ahi un desfasaje de
// horario si importa: sin esto, "15:00" cargado en la app (que la app interpreta bien
// como hora de Italia) se escribia en la planilla usando la hora UTC cruda (13:00),
// y a la inversa al leer. No se asume que el proceso de Node corre en zona horaria de
// Italia (podria no ser asi en produccion) - se usa Intl.DateTimeFormat para resolver
// el offset real (CET/CEST) de la fecha en cuestion, sea cual sea el TZ del proceso.
const SHEET_TIMEZONE = "Europe/Rome";

// Creado una sola vez (armar uno en cada llamada deja memoria nativa; ver utils/romeTime.js).
const SHEET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: SHEET_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const romeOffsetMinutesForUtc = (utcDate) => {
  const parts = Object.fromEntries(
    SHEET_FORMAT
      .formatToParts(utcDate)
      .map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asIfUtc - utcDate.getTime()) / 60000);
};

// Instante UTC (Date o string ISO) -> componentes de hora de pared en Italia, para
// escribir la columna ETA de la planilla.
export const toRomeParts = (value) => {
  const d = new Date(value);
  const offsetMin = romeOffsetMinutesForUtc(d);
  const shifted = new Date(d.getTime() + offsetMin * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
};

// Componentes de hora de pared en Italia (los que trae la columna ETA de la planilla)
// -> Date en el instante UTC correcto, para guardar en la base. Un solo ajuste
// alcanza salvo parado justo en la hora exacta del cambio de horario (2 veces al
// anio) - caso extremo que no vale la pena resolver con mas precision aca.
export const fromRomeParts = (year, month, day, hour = 0, minute = 0) => {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMin = romeOffsetMinutesForUtc(new Date(guessUtcMs));
  return new Date(guessUtcMs - offsetMin * 60000);
};
