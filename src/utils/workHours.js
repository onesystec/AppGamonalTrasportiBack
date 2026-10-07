import { DAY_BAND } from "../config/payRates.js";
import { romeHHMM, romeLocalToDate } from "./romeTime.js";

const MIN_MS = 60000;
const DAY_MS = 24 * 60 * MIN_MS;
// Tope de una jornada declarada: mas que esto casi seguro es un error de carga (fecha mal).
export const MAX_SHIFT_MIN = 24 * 60;

const romeDayOf = (date) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });

// Instantes (ms) de cada cambio de banda (07:00 y 19:00 de Roma) entre dos instantes.
const bandBoundaries = (fromMs, toMs) => {
  const out = [];
  for (let t = fromMs - DAY_MS; t <= toMs + DAY_MS; t += DAY_MS) {
    const day = romeDayOf(new Date(t));
    out.push(romeLocalToDate(day, DAY_BAND.start).getTime(), romeLocalToDate(day, DAY_BAND.end).getTime());
  }
  return [...new Set(out)].sort((a, b) => a - b);
};

const isDayMoment = (ms) => {
  const hhmm = romeHHMM(new Date(ms));
  return hhmm >= DAY_BAND.start && hhmm < DAY_BAND.end;
};

// Minutos de [inicio, fin) que caen en banda diurna y nocturna, en hora de Roma (respeta el
// cambio de hora). Un tramo se clasifica por su punto medio: los limites son exactos.
export const splitDayNightMinutes = (inicio, fin) => {
  const startMs = new Date(inicio).getTime();
  const endMs = new Date(fin).getTime();
  const cuts = [startMs, ...bandBoundaries(startMs, endMs).filter((b) => b > startMs && b < endMs), endMs];
  let diaMin = 0;
  let nocheMin = 0;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const minutes = (cuts[i + 1] - cuts[i]) / MIN_MS;
    if (isDayMoment((cuts[i] + cuts[i + 1]) / 2)) diaMin += minutes;
    else nocheMin += minutes;
  }
  return { diaMin, nocheMin };
};

const round4 = (value) => Math.round(value * 10000) / 10000;

// De la jornada declarada (inicio, fin, espera y pausa en minutos) a las horas que se pagan:
//  - La espera y la pausa estan DENTRO de [inicio, fin]; la espera se paga aparte y la pausa no
//    se paga, asi que se restan del tiempo trabajado.
//  - Lo trabajado se reparte entre dia y noche en la misma proporcion que la jornada completa
//    (no sabemos a que hora cayeron la espera o la pausa).
// Devuelve un error de texto si los datos no cierran.
export const computeShiftHours = ({ inicio, fin, esperaMin = 0, pausaMin = 0 }) => {
  const startMs = new Date(inicio).getTime();
  const endMs = new Date(fin).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { error: "Fechas de inicio o fin invalidas" };
  if (endMs <= startMs) return { error: "La hora de fin debe ser posterior a la de inicio" };

  const totalMin = (endMs - startMs) / MIN_MS;
  if (totalMin > MAX_SHIFT_MIN) return { error: "La jornada no puede superar las 24 horas, revisa las fechas" };

  const espera = Math.max(0, Math.round(esperaMin || 0));
  const pausa = Math.max(0, Math.round(pausaMin || 0));
  if (espera + pausa > totalMin) return { error: "La espera y la pausa no pueden superar la jornada" };

  const { diaMin, nocheMin } = splitDayNightMinutes(startMs, endMs);
  const workedMin = totalMin - espera - pausa;
  const factor = totalMin > 0 ? workedMin / totalMin : 0;

  return {
    totalMin,
    workedMin,
    esperaMin: espera,
    pausaMin: pausa,
    horasDia: round4((diaMin * factor) / 60),
    horasNoche: round4((nocheMin * factor) / 60),
    tiempoEspera: round4(espera / 60),
  };
};
