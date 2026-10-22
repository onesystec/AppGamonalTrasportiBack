// Ventana de pausa con hora de Roma, escrita "HH:MM-HH:MM" (por ejemplo "00:00-04:00"). Dentro de ella, las tareas de fondo que consultan la
// base cada minuto no corren, para que Neon pueda dormirse (la base se apaga a los 5 minutos sin consultas y se cobra por hora despierta).
// Acepta ventanas que cruzan la medianoche ("23:30-04:00"). Vacio o invalido = sin pausa.
export const parsePausa = (spec) => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec ?? "");
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const desde = h1 * 60 + m1;
  const hasta = h2 * 60 + m2;
  return desde === hasta ? null : { desde, hasta };
};

const ROME_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Minutos desde la medianoche en Roma.
const romeMinutes = (date) => {
  const parts = ROME_TIME.formatToParts(date);
  return Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
};

// true si "date" cae dentro de la pausa (desde incluido, hasta excluido).
export const enPausa = (pausa, date = new Date()) => {
  if (!pausa) return false;
  const now = romeMinutes(date);
  return pausa.desde < pausa.hasta ? now >= pausa.desde && now < pausa.hasta : now >= pausa.desde || now < pausa.hasta;
};
