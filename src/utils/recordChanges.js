import { randomUUID } from "node:crypto";

// Registro en memoria de que dias de servicios cambiaron (se crea, edita o borra un servicio desde cualquier lado: la app, el bot de Telegram o un
// proceso automatico). Las pantallas de Registros lo consultan cada pocos segundos (GET /records/cambios) y vuelven a pedir SOLO los dias que
// cambiaron, en vez de recargar todo o esperar a que alguien recargue la app. No toca la base de datos (no despierta a Neon): es un contador y una
// lista corta en el proceso.
//  - dia: "AAAA-MM-DD" (el dia del servicio, igual que las claves del acordeon) o null si no se pudo saber cual (entonces las pantallas se
//    refrescan completas).
//  - instancia: cambia cada vez que se reinicia el servidor: un contador de otra vida del servidor no sirve y obliga a refrescar todo.
const INSTANCIA = randomUUID();
const MAX_LOG = 300;
let seq = 0;
const log = [];

export const noteRecordChange = (day) => {
  seq += 1;
  log.push({ seq, day: day ?? null });
  if (log.length > MAX_LOG) log.shift();
};

// Dias de la fecha de servicio que toca una escritura de Record, a partir de lo que devolvio Prisma (un servicio, una lista, o { count }).
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);
export const recordChangeDays = (result, args, operation) => {
  const days = new Set();
  const collect = (r) => days.add(r?.fechaServicio ? new Date(r.fechaServicio).toISOString().slice(0, 10) : null);
  if (Array.isArray(result)) result.forEach(collect);
  else if (result && typeof result === "object" && "id" in result) collect(result);
  else days.add(null);
  // Si una EDICION cambia la fecha del servicio, el dia de antes no se conoce: que se refresque todo (crear uno nuevo no tiene dia anterior).
  if (!CREATE_OPERATIONS.has(operation)) {
    const edits = [args?.data, args?.update].filter((d) => d && typeof d === "object");
    if (edits.some((d) => "fechaServicio" in d)) days.add(null);
  }
  return [...days];
};

export const getRecordChanges = ({ desde, instancia } = {}) => {
  const base = { version: seq, instancia: INSTANCIA };
  // Primera consulta de la pantalla: solo se anota la version actual (no hay nada que refrescar).
  if (desde == null || Number.isNaN(Number(desde))) return { ...base, dias: [] };
  if (instancia !== INSTANCIA || Number(desde) > seq) return { ...base, dias: null };
  const since = Number(desde);
  if (log.length && since < log[0].seq - 1) return { ...base, dias: null };
  const nuevos = log.filter((l) => l.seq > since);
  if (nuevos.some((l) => l.day == null)) return { ...base, dias: null };
  return { ...base, dias: [...new Set(nuevos.map((l) => l.day))] };
};
