// Festivos nacionales de Italia ("AAAA-MM-DD" en hora de Roma). Los dias de santo patrono de cada
// ciudad (Milan 7/12, Roma 29/6) no estan: agregalos a FIJOS si tambien se pagan como reperibilidad.
const FIJOS = ["01-01", "01-06", "04-25", "05-01", "06-02", "08-15", "11-01", "12-08", "12-25", "12-26"];

// Domingo de Pascua (algoritmo gregoriano de Meeus/Jones/Butcher).
const easterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
};

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export const esFestivoIT = (day) => {
  if (FIJOS.includes(day.slice(5))) return true;
  const pasquetta = ymd(easterSunday(Number(day.slice(0, 4))) + 24 * 60 * 60 * 1000);
  return day === pasquetta;
};

// Todos los festivos de un año ("AAAA-MM-DD"), para que el front calcule la vista previa con la misma lista.
export const festivosDelAnio = (year) => {
  const list = FIJOS.map((md) => `${year}-${md}`);
  list.push(ymd(easterSunday(year) + 24 * 60 * 60 * 1000));
  return list.sort();
};
