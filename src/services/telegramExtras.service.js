import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { findOverlappingPermisos, getConfig, setConfig } from "../models/permiso.model.js";
import { findUserByEmail } from "../models/user.model.js";
import { recordAreaWhere } from "../utils/areaAccess.js";
import { romeHHMM, romeLocalToDate } from "../utils/romeTime.js";
import { defaultSalidaFor } from "../constants/salidaPorDefecto.js";
import { geocodePreview, geocodeStops } from "./geocoding.service.js";
import { calculateRoute } from "./routing.service.js";
import { deleteRecord } from "./record.service.js";
import { TIPOS, norm, zonaDe } from "./telegramEngine.js";

// Piezas del bot que hablan con la base: quien escribe, choques con otros servicios, /hoy y /deshacer.

const UNDO_WINDOW_MS = 10 * 60 * 1000;
// Sin usuario vinculado el servicio se carga como siempre (sin area): para borrar/listar se usa un Admin generico.
const SYSTEM_ACTOR = { id: "telegram", cargo: "OWNER" };

// ---------------------------------------------------------------------------------------------------------------------
// Quien escribe
// ---------------------------------------------------------------------------------------------------------------------
const parseUserMap = () => {
  if (!env.TELEGRAM_USER_MAP) return null;
  try {
    const map = JSON.parse(env.TELEGRAM_USER_MAP);
    return map && typeof map === "object" && Object.keys(map).length ? map : null;
  } catch {
    console.error("[telegram] TELEGRAM_USER_MAP no es un JSON valido, se ignora");
    return null;
  }
};

// Sin TELEGRAM_USER_MAP: todo el grupo carga igual que siempre (actor null). Con el mapa: solo las personas vinculadas, y cada
// servicio se carga "como" ese usuario.
export const resolveTelegramActor = async (from) => {
  const map = parseUserMap();
  const display = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "Telegram";
  if (!map) return { ok: true, actor: null, name: display };
  const email = map[String(from?.id)];
  if (!email) {
    return { ok: false, reply: `Tu usuario de Telegram (id ${from?.id}) no está vinculado a un usuario del app. Pídele al Admin que lo agregue.` };
  }
  const user = await findUserByEmail(email);
  if (!user || user.estado !== "ACTIVO" || !["OWNER", "ADMIN"].includes(user.cargo)) {
    return { ok: false, reply: "Tu usuario del app no puede cargar servicios (tiene que ser Admin o Responsable activo)." };
  }
  return { ok: true, actor: user, name: `${user.nombre} ${user.apellido}` };
};

export const actorOrSystem = (who) => who.actor ?? SYSTEM_ACTOR;

// ---------------------------------------------------------------------------------------------------------------------
// Avisos antes de confirmar: choques con otros servicios, permisos, vehiculo no disponible y ciudades mal ubicadas
// ---------------------------------------------------------------------------------------------------------------------
const VEHICULO_ESTADO = { EN_MANTENIMIENTO: "en mantenimiento", FUERA_DE_SERVICIO: "fuera de servicio" };

const stopWarnings = async (state) => {
  const last = state.destinos.at(-1);
  const results = await Promise.allSettled(state.destinos.slice(0, 6).map((d) => geocodePreview(d, last)));
  const out = [];
  results.forEach((r, i) => {
    const stop = state.destinos[i];
    if (r.status === "rejected") {
      out.push(`No pude ubicar «${stop}» en el mapa. Escríbela con la provincia (ej: ruta: Lodi LO - Piacenza PC).`);
      return;
    }
    const formatted = r.value;
    if (!formatted) return;
    const first = norm(stop).split(" ")[0];
    if (!/\bital(?:ia|y)\b/i.test(norm(formatted)) || (first.length >= 3 && !norm(formatted).includes(first))) {
      out.push(`«${stop}» la ubiqué en «${formatted}». Si no es esa, escríbela con la provincia (ej: Lodi LO).`);
    }
  });
  return out;
};

// Para un codigo repetido, el siguiente libre con la costumbre de la oficina: CODIGO-B, CODIGO-C...
const nextFreeCode = async (code) => {
  const base = code.replace(/-[A-Z]$/, "");
  const taken = new Set((await prisma.record.findMany({ where: { codigo: { startsWith: base } }, select: { codigo: true } })).map((r) => r.codigo));
  for (const letter of "BCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.has(`${base}-${letter}`)) return `${base}-${letter}`;
  return `${base}-2`;
};

export const checkConflicts = async (state, refs) => {
  const warnings = [];
  const eta = romeLocalToDate(state.fecha, state.hora);
  const from = new Date(eta.getTime() - 90 * 60000);
  const to = new Date(eta.getTime() + 90 * 60000);
  const day = new Date(`${state.fecha}T00:00:00.000Z`);
  const driver = refs.drivers.find((d) => d.id === state.driverId);
  const vehicle = refs.vehicles.find((v) => v.id === state.vehicleId);
  const driverName = driver ? `${driver.nombre} ${driver.apellido}` : "El chofer";

  try {
    const [others, permisos, stops] = await Promise.all([
      prisma.record.findMany({
        where: {
          eta: { gte: from, lte: to },
          estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] },
          OR: [{ driverId: state.driverId }, { vehicleId: state.vehicleId }],
        },
        select: { codigo: true, eta: true, driverId: true, vehicleId: true, clientId: true },
        orderBy: { eta: "asc" },
        take: 6,
      }),
      findOverlappingPermisos(state.driverId, day, day),
      stopWarnings(state),
    ]);
    for (const o of others) {
      const at = romeHHMM(o.eta);
      const sameDriver = o.driverId === state.driverId;
      const sameVehicle = o.vehicleId === state.vehicleId;
      if (sameDriver && sameVehicle && o.clientId === state.clientId && Math.abs(o.eta - eta) <= 10 * 60000) {
        warnings.push(`Parece duplicado: ya existe el servicio ${o.codigo} de ${driverName} a las ${at} con el mismo vehículo y cliente.`);
      } else if (sameDriver) warnings.push(`${driverName} ya tiene un servicio a las ${at} (${o.codigo}).`);
      else if (sameVehicle) warnings.push(`El vehículo ${vehicle?.targa ?? ""} ya está en un servicio a las ${at} (${o.codigo}).`);
    }
    if (state.codigo) {
      const dup = await prisma.record.findUnique({
        where: { codigo: state.codigo },
        select: { eta: true, driver: { select: { nombre: true, apellido: true } } },
      });
      if (dup) {
        const next = await nextFreeCode(state.codigo);
        warnings.push(
          `Ya existe un servicio con el código ${state.codigo} (${dup.driver.nombre} ${dup.driver.apellido}, ${romeHHMM(dup.eta)}). Si es otro servicio con el mismo código, escribe: código ${next}`
        );
      }
    }
    for (const p of permisos) warnings.push(`${driverName} tiene un ${p.estado === "APROBADO" ? "permiso aprobado" : "permiso pendiente"} ese día.`);
    warnings.push(...stops);
  } catch (err) {
    // Los avisos son un extra: si algo falla no se frena la carga.
    console.error("[telegram] No se pudieron revisar los choques:", err.message);
  }
  if (vehicle && VEHICULO_ESTADO[vehicle.estado]) warnings.push(`El vehículo ${vehicle.targa} figura ${VEHICULO_ESTADO[vehicle.estado]}.`);
  return warnings;
};

// ---------------------------------------------------------------------------------------------------------------------
// /hoy
// ---------------------------------------------------------------------------------------------------------------------
const ESTADO_CORTO = {
  IN_SOSPESO: "pendiente",
  IN_CONSEGNA: "en entrega",
  RITIRATO: "retirado",
  CONSEGNATO: "entregado",
  ANNULLATO: "anulado",
  RISCHEDULATO: "reprogramado",
};

const tipoLabel = (r) => {
  const zona = r.extrasPiazzaZona ?? "MILANO";
  const tipo = Object.values(TIPOS).find((t) => t.spedizzione === (r.spedizzione ?? "EXTRA_PIAZZA") && (t.zonaVariable || t.zona === null || t.zona === zona));
  return tipo?.label ?? "Servicio";
};

export const listToday = async (who, today) => {
  const start = romeLocalToDate(today, "00:00");
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const actor = who.actor;
  const records = await prisma.record.findMany({
    where: { eta: { gte: start, lt: end }, ...(actor ? recordAreaWhere(actor) : {}) },
    orderBy: { eta: "asc" },
    take: 40,
    select: {
      codigo: true,
      eta: true,
      estado: true,
      spedizzione: true,
      extrasPiazzaZona: true,
      destinazione: true,
      driver: { select: { nombre: true, apellido: true } },
    },
  });
  if (!records.length) return "Hoy no hay servicios cargados.";
  const lines = records.map(
    (r) => `${romeHHMM(r.eta)} · ${tipoLabel(r)} · ${r.driver.nombre} ${r.driver.apellido} · ${(r.destinazione ?? "-").slice(0, 40)} · ${ESTADO_CORTO[r.estado] ?? r.estado} · ${r.codigo}`
  );
  const head = `Hoy (${today.slice(8, 10)}/${today.slice(5, 7)}): ${records.length}${records.length === 40 ? "+" : ""} servicio${records.length > 1 ? "s" : ""}`;
  return [head, ...lines].join("\n");
};

// ---------------------------------------------------------------------------------------------------------------------
// /deshacer: anula lo ultimo que cargo esa persona, solo dentro de los 10 minutos y si nadie lo toco
// ---------------------------------------------------------------------------------------------------------------------
const undoKey = (userKey) => `telegram.ultimo.${userKey}`;

export const rememberCreated = (userKey, ids) => setConfig(undoKey(userKey), { ids, at: Date.now() });

export const undoLast = async (userKey, who) => {
  const row = await getConfig(undoKey(userKey));
  const last = row?.valor;
  if (!last?.ids?.length || Date.now() - last.at > UNDO_WINDOW_MS) {
    return { text: "No hay nada para deshacer (solo se puede en los 10 minutos siguientes a cargar).", anulados: [] };
  }
  const lines = [];
  const anulados = [];
  for (const id of last.ids) {
    const record = await prisma.record.findUnique({ where: { id }, select: { id: true, codigo: true, estado: true } });
    if (!record) continue;
    if (record.estado !== "IN_SOSPESO") {
      lines.push(`${record.codigo}: ya cambió de estado, no se puede deshacer desde acá.`);
      continue;
    }
    try {
      await deleteRecord(actorOrSystem(who), id);
      lines.push(`${record.codigo}: anulado.`);
      anulados.push(record.codigo);
    } catch (err) {
      lines.push(`${record.codigo}: no se pudo anular (${err.message}).`);
    }
  }
  await setConfig(undoKey(userKey), { ids: [], at: 0 });
  return { text: lines.length ? ["Deshecho:", ...lines].join("\n") : "Ese servicio ya no existe.", anulados };
};

// ---------------------------------------------------------------------------------------------------------------------
// Ruta estimada (Extras Piazza): salida -> paradas, en el mismo orden y con el mismo motor que usa el servicio al crearse. Devuelve
// { distanciaKm, duracionMin } o null si no se pudo (el bot pregunta la ETA a mano).
// ---------------------------------------------------------------------------------------------------------------------
export const estimateRoute = async (state) => {
  try {
    const tipo = TIPOS[state.tipo];
    const salida = defaultSalidaFor({ spedizzione: tipo.spedizzione, extrasPiazzaZona: zonaDe(state) ?? undefined });
    const stops = await geocodeStops(state.destinos, state.destinos.at(-1));
    const ruta = await calculateRoute([{ lat: salida.lat, lng: salida.lng }, ...stops.map((x) => ({ lat: x.lat, lng: x.lng }))]);
    return ruta ? { distanciaKm: ruta.distanciaKm, duracionMin: ruta.duracionMin } : null;
  } catch (err) {
    console.error("[telegram] No se pudo estimar la ruta:", err.message);
    return null;
  }
};
