import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findRecordById } from "../models/record.model.js";
import { findRecorrido, saveRecorrido } from "../models/recorrido.model.js";
import { findGroupMembers } from "../models/seguimiento.model.js";
import { AppError } from "../utils/AppError.js";
import { canAccessRecordArea } from "../utils/areaAccess.js";
import { compareTracks, evaluateReasons, routeCrossesPolygon, toLineString } from "../utils/trackCompare.js";
import { findOnesystecVehicleIdByPlate, getVehiclePositions, isOnesystecConfigured } from "./onesystec.service.js";
import { peajeLabel, peajesEnRuta } from "./peajes.service.js";
import { getCircuitMapData } from "./rutaEstimada.service.js";

// Recorrido real de un servicio (GPS de OneSystec) comparado con la ruta planificada: cuanto se desvio, tramos fuera de ruta, km de mas, peajes
// que cruzo y si paso por el Area C. No se guarda el GPS en tiempo real: el historial ya lo tiene OneSystec, aca se pide una vez (al cerrar el
// servicio o la primera vez que alguien lo mira) y se guarda un resumen y la linea simplificada (unos KB) en RecorridoReal.
// Solo vehiculos que esten en OneSystec: el GPS de Velocity Fleet no tiene historial integrado.
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const ANTES_DE_SALIR_MS = 20 * MIN_MS;
const DESPUES_DE_ETA_MS = 3 * HOUR_MS;
const MAX_VENTANA_MS = 16 * HOUR_MS;
const MIN_PUNTOS = 5;
// Sin datos o sin llegar: se vuelve a calcular al mirarlo si pasaron mas de estos minutos.
const REINTENTO_MS = 10 * MIN_MS;

const AREA_C_PATH = JSON.parse(readFileSync(fileURLToPath(new URL("../constants/milanoZones.json", import.meta.url)), "utf8")).areaC;

const sinDatos = (motivo) => ({
  estado: "SIN_DATOS",
  resumen: { sinDatos: true, motivo, calculadoAt: new Date().toISOString() },
  geometria: null,
});

// La ruta planificada de ida: la del circuito (la misma que se ve en "Circuito en el mapa", sirve tambien para viajes compactados) o, si no hay
// circuito, la ruta guardada del servicio.
const planDe = async (record) => {
  const circuit = await getCircuitMapData(record.id).catch(() => null);
  const ida = circuit?.rutas?.find((r) => r.tipo === "IDA")?.geometria;
  if (ida?.coordinates?.length > 1) {
    const paradas = (circuit.puntos ?? []).filter((p) => p.tipo === "PARADA");
    return {
      coords: ida.coordinates,
      puntos: circuit.puntos,
      kmPlan: circuit.circuito?.idaKm ?? null,
      finalStop: paradas.at(-1) ? { lat: paradas.at(-1).lat, lng: paradas.at(-1).lng } : null,
      fuente: "CIRCUITO",
    };
  }
  const stored = record.rutaGeometria?.coordinates;
  if (stored?.length > 1) {
    const stops = (record.stops ?? []).filter((s) => s.lat != null && s.lng != null);
    return {
      coords: stored,
      puntos: stops.map((s) => ({ tipo: "PARADA", nombre: s.direccion, lat: s.lat, lng: s.lng })),
      kmPlan: record.rutaDistanciaKm ?? null,
      finalStop: stops.at(-1) ? { lat: stops.at(-1).lat, lng: stops.at(-1).lng } : null,
      fuente: "RUTA",
    };
  }
  return null;
};

// Horario a pedir al GPS: desde un rato antes de la salida hasta unas horas despues de la ETA (la vuelta), sin pasar de ahora. En un viaje
// compactado, de la primera salida a la ultima ETA.
const ventanaDe = async (record) => {
  const members = record.compactadoId ? await findGroupMembers([record.compactadoId]) : [record];
  const list = members.length ? members : [record];
  const salidas = list.map((m) => new Date(m.fechaRetiro ?? m.fechaServicio).getTime());
  const fines = list.flatMap((m) => [m.eta, m.llegadaGpsAt].filter(Boolean).map((d) => new Date(d).getTime()));
  const from = Math.min(...salidas) - ANTES_DE_SALIR_MS;
  const to = Math.min(Date.now(), Math.min(Math.max(...fines, from) + DESPUES_DE_ETA_MS, from + MAX_VENTANA_MS));
  return { from, to };
};

const nombresPeajes = (peajes) => [...new Set(peajes.map(peajeLabel))].slice(0, 12);

// Calcula, guarda y devuelve el recorrido real de un servicio. plan: para pruebas, evita calcular la ruta planificada.
export const computeRecorrido = async (recordId, { plan: planOverride } = {}) => {
  const record = await findRecordById(recordId);
  if (!record) throw new AppError("Servicio no encontrado", 404);
  const guardar = async (result) => {
    await saveRecorrido(recordId, result);
    return result;
  };

  const targa = record.vehicle?.targa;
  if (!targa) return guardar(sinDatos("El servicio no tiene vehículo."));
  if (!isOnesystecConfigured()) return guardar(sinDatos("La conexión con el GPS (OneSystec) no está configurada."));
  const onesystecId = await findOnesystecVehicleIdByPlate(targa).catch(() => undefined);
  if (onesystecId === undefined) return guardar(sinDatos("No se pudo consultar OneSystec en este momento."));
  if (!onesystecId) return guardar(sinDatos(`El vehículo ${targa} no está en OneSystec (solo hay historial de los vehículos con ese GPS).`));

  const plan = planOverride ?? (await planDe(record));
  if (!plan) return guardar(sinDatos("El servicio no tiene una ruta planificada."));

  const { from, to } = await ventanaDe(record);
  if (from >= Date.now()) return guardar(sinDatos("El servicio todavía no salió."));
  let rows;
  try {
    rows = await getVehiclePositions(onesystecId, from, to);
  } catch {
    return guardar(sinDatos("No se pudo leer el historial de OneSystec."));
  }
  if (rows.length < MIN_PUNTOS) return guardar(sinDatos("OneSystec no tiene puntos del vehículo en el horario del servicio."));

  const comparison = compareTracks({ planCoords: plan.coords, rows, finalStop: plan.finalStop, kmPlan: plan.kmPlan, areaCPath: AREA_C_PATH });
  if (!comparison) return guardar(sinDatos("Hay muy pocos puntos del GPS para comparar el recorrido."));

  // Peajes: los que cruzo de verdad contra los que el plan preveia.
  const [reales, previstos] = await Promise.all([
    peajesEnRuta(toLineString(comparison.linea), { radiusM: 90 }),
    peajesEnRuta({ coordinates: plan.coords }),
  ]);
  const previstosIds = new Set(previstos.map((p) => p.id));
  const realesIds = new Set(reales.map((p) => p.id));
  const noPrevistos = reales.filter((p) => !previstosIds.has(p.id));
  const sinCruzar = previstos.filter((p) => !realesIds.has(p.id));
  const areaCPrevista = routeCrossesPolygon(plan.coords, AREA_C_PATH);

  const { estado, motivos } = evaluateReasons(comparison.resumen, { peajesNoPrevistos: nombresPeajes(noPrevistos), areaCPrevista });
  const resumen = {
    ...comparison.resumen,
    sinDatos: false,
    fuente: "ONESYSTEC",
    planFuente: plan.fuente ?? "RUTA",
    peajes: { reales: nombresPeajes(reales), noPrevistos: nombresPeajes(noPrevistos), sinCruzar: nombresPeajes(sinCruzar) },
    estado,
    motivos,
    calculadoAt: new Date().toISOString(),
  };
  return guardar({ estado, resumen, geometria: toLineString(comparison.linea) });
};

// Sin romper nunca el flujo que lo llama (cerrar un servicio).
export const computeRecorridoSafe = (recordId) =>
  computeRecorrido(recordId).catch((err) => console.error("No se pudo comparar el recorrido del servicio:", err.message));

// Para la pantalla (OWNER/ADMIN): el recorrido guardado (o calculado ahora si todavia no hay, o si quedo sin datos/sin llegar hace un rato) y la ruta
// planificada para dibujarlas juntas.
export const getRecorridoForActor = async (actor, recordId, { recalcular = false } = {}) => {
  const record = await findRecordById(recordId);
  if (!record) throw new AppError("Servicio no encontrado", 404);
  if (actor.cargo !== "OWNER" && !canAccessRecordArea(actor, record)) throw new AppError("No tienes permisos para realizar esta accion", 403);

  let stored = await findRecorrido(recordId);
  const edadMs = stored ? Date.now() - new Date(stored.calculadoAt).getTime() : Infinity;
  const stale = stored && edadMs > REINTENTO_MS && (stored.resumen?.sinDatos || stored.resumen?.llego === false);
  let result;
  if (!stored || recalcular || stale) {
    result = await computeRecorrido(recordId);
  } else {
    result = { estado: record.recorridoEstado ?? stored.resumen?.estado ?? "OK", resumen: stored.resumen, geometria: stored.geometria };
  }
  const plan = await planDe(record);
  return {
    estado: result.estado,
    resumen: result.resumen,
    real: result.geometria,
    plan: plan ? { geometria: { type: "LineString", coordinates: plan.coords }, puntos: plan.puntos, kmPlan: plan.kmPlan } : null,
  };
};
