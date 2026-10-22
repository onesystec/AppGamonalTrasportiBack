// Fechas y duraciones en espanol con hora de Roma, para correos y documentos. Los formateadores se crean una sola vez.
const FECHA_LARGA = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const HORA = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const capitalizar = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export const fechaLarga = (date) => capitalizar(FECHA_LARGA.format(date));
// Igual pero en minuscula, para meterla en una frase ("antes del viernes, 23 de octubre de 2026").
export const fechaEnFrase = (date) => FECHA_LARGA.format(date);
export const hora = (date) => HORA.format(date);

// "38 h 20 min", "5 h", "45 min".
export const duracion = (minutos) => {
  const total = Math.max(0, Math.round(minutos));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
};
