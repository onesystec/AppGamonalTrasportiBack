const ROME = "Europe/Rome";

// Los formateadores de fecha se crean UNA vez. Llamar a toLocaleDateString/toLocaleTimeString/Intl.DateTimeFormat con opciones en cada
// vez arma un formateador nuevo y deja ~6 KB de memoria nativa por llamada: con miles de servicios eso llegaba a cientos de MB
// (200.000 llamadas = 1,3 GB y 7 s; con el formateador reutilizado 22 MB y 0,1 s, con el mismo resultado).
const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: ROME });
const HHMM_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: ROME, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WALL_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: ROME,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: ROME, weekday: "short" });

const toDate = (value) => (value instanceof Date ? value : new Date(value));

// Un instante -> "AAAA-MM-DD" en hora de Roma (sin argumento, hoy).
export const romeDay = (date = new Date()) => {
  const d = toDate(date);
  return Number.isNaN(d.getTime()) ? "Invalid Date" : DAY_FORMAT.format(d);
};

// Un instante -> dia de la semana en ingles abreviado ("Mon".."Sun") en hora de Roma.
export const romeWeekdayShort = (date) => WEEKDAY_FORMAT.format(toDate(date));

// Diferencia (ms) entre la hora de pared de Roma y UTC en un instante dado (3.600.000 en
// invierno, 7.200.000 en verano).
const romeOffsetMs = (ts) => {
  const parts = WALL_FORMAT.formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return wall - Math.floor(ts / 60000) * 60000;
};

// "2026-10-12" + "08:40" (hora de pared de Roma) -> el instante real. Se calcula dos veces el
// desfase para acertar tambien cerca de los cambios de hora de verano.
export const romeLocalToDate = (day, hhmm) => {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const first = wall - romeOffsetMs(wall);
  return new Date(wall - romeOffsetMs(first));
};

// Un instante -> "HH:MM" en hora de Roma.
export const romeHHMM = (date) => HHMM_FORMAT.format(toDate(date));
