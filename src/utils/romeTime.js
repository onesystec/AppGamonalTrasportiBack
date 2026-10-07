const ROME = "Europe/Rome";

// Diferencia (ms) entre la hora de pared de Roma y UTC en un instante dado (3.600.000 en
// invierno, 7.200.000 en verano).
const romeOffsetMs = (ts) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ROME,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ts));
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
export const romeHHMM = (date) =>
  new Date(date).toLocaleTimeString("en-GB", { timeZone: ROME, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
