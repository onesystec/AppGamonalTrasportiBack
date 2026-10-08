import { DEPOT_ORIGIN } from "../constants/depot.js";
import { WORK_PLACES } from "../constants/workPlaces.js";
import { env } from "../config/env.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { findRecordById, updateRecordById } from "../models/record.model.js";
import { AppError } from "../utils/AppError.js";
import { estimateDriveMinutes } from "../utils/stopDetection.js";
import { geocodeAddress } from "./geocoding.service.js";
import { calculateRoute } from "./routing.service.js";

// Estimacion del tiempo de un servicio SOLO con sus direcciones, para cuando no hay datos de GPS ni del
// vehiculo ni del celular: hora de retiro + salida, paradas hasta la entrega final y retorno. Es una
// referencia para el revisor (compara lo declarado con lo razonable), no un dato medido, y no cambia el
// pago. El tiempo de OSRM es sin trafico: se le aplica un recargo, mas un tiempo fijo por parada y un
// descanso cada cierto tiempo de conduccion (ver ESTIMATE_* en env.js).
const MIN_MS = 60000;
const RETURN_KEY = "ruta.retorno";

const placeByName = (name) => WORK_PLACES.find((p) => p.nombre === name);
const DEFAULT_RETURN_PLACE = () => placeByName("Lugar de espera Milano");

// A que lugar de espera vuelve el vehiculo segun el area del servicio.
const areaReturnPlace = (record) => {
  if (record.extrasPiazzaZona === "ROMA") return placeByName("Lugar de espera Roma (Extras Piazza)");
  if (record.aplicativo?.startsWith("ROMA_")) return placeByName("Lugar de espera Roma");
  if (record.extrasPiazzaZona === "MILANO" || record.aplicativo?.startsWith("MILANO_")) {
    return placeByName("Lugar de espera Milano");
  }
  return null;
};

// ------------------------------------------------------------------- direccion de retorno por defecto

// { direccion, lat, lng } o null si no se configuro ninguna.
const readReturnConfig = async () => {
  const value = (await getConfig(RETURN_KEY))?.valor;
  return value?.direccion ? value : null;
};

export const getReturnSettings = async () => {
  const configured = await readReturnConfig();
  const fallback = DEFAULT_RETURN_PLACE();
  return {
    configurada: configured,
    porDefecto: { nombre: fallback.nombre, direccion: fallback.direccion },
  };
};

// direccion vacia/null = quitar la configurada (vuelve a Milano). Se geocodifica; si no se encuentra se
// avisa en vez de guardar una direccion que no se puede ubicar.
export const setReturnSettings = async (direccion) => {
  const text = direccion?.trim();
  if (!text) {
    await setConfig(RETURN_KEY, { direccion: null });
    return getReturnSettings();
  }
  const { lat, lng } = await geocodeAddress(text);
  await setConfig(RETURN_KEY, { direccion: text, lat, lng });
  return getReturnSettings();
};

const resolveReturn = async (record) => {
  const place = areaReturnPlace(record);
  if (place) return { nombre: place.nombre, direccion: place.direccion, lat: place.lat, lng: place.lng, fuente: "area" };
  const configured = await readReturnConfig();
  if (configured) {
    return { nombre: "la direccion de retorno", direccion: configured.direccion, lat: configured.lat, lng: configured.lng, fuente: "configurada" };
  }
  const fallback = DEFAULT_RETURN_PLACE();
  return { nombre: fallback.nombre, direccion: fallback.direccion, lat: fallback.lat, lng: fallback.lng, fuente: "por defecto" };
};

// ------------------------------------------------------------------- estimacion de un servicio

export const computeEstimacionForRecord = async (recordId) => {
  const record = await findRecordById(recordId);
  if (!record) throw new AppError("Registro no encontrado", 404);
  if (record.servicioOrigenId || record.continuaciones?.length) {
    throw new AppError("Un servicio traspasado entre choferes no se puede estimar por ruta", 409);
  }

  const stops = (record.stops ?? [])
    .filter((s) => s.lat != null && s.lng != null)
    .sort((a, b) => a.orden - b.orden);
  if (stops.length === 0) throw new AppError("El servicio no tiene paradas ubicadas en el mapa", 409);

  const salida =
    record.salidaLat != null && record.salidaLng != null
      ? { direccion: record.salidaDireccion ?? "Salida", lat: record.salidaLat, lng: record.salidaLng }
      : { direccion: DEPOT_ORIGIN.direccion, lat: DEPOT_ORIGIN.lat, lng: DEPOT_ORIGIN.lng };

  const factor = env.ESTIMATE_TRAFFIC_FACTOR;
  // Ida: salida -> paradas en orden. Si ya esta calculada al cargar el servicio se reutiliza.
  let idaBase = record.rutaDuracionMin != null && record.rutaCalculadaAt ? record.rutaDuracionMin : null;
  let distanciaIdaKm = record.rutaDuracionMin != null && record.rutaCalculadaAt ? record.rutaDistanciaKm : null;
  let estimada = false;
  if (idaBase == null) {
    const route = await calculateRoute([salida, ...stops]);
    if (route) {
      idaBase = route.duracionMin;
      distanciaIdaKm = route.distanciaKm;
    } else {
      idaBase = [salida, ...stops].slice(1).reduce((sum, stop, i) => sum + estimateDriveMinutes([salida, ...stops][i], stop), 0);
      estimada = true;
    }
  }

  const lastStop = stops[stops.length - 1];
  const retorno = await resolveReturn(record);
  const back = await calculateRoute([lastStop, retorno]);
  const vueltaBase = back ? back.duracionMin : estimateDriveMinutes(lastStop, retorno);

  const idaMin = Math.round(idaBase * factor);
  const vueltaMin = Math.round(vueltaBase * factor);
  const paradasMin = stops.length * env.ESTIMATE_STOP_MIN;
  const descansosHastaUltima = Math.floor(idaMin / env.ESTIMATE_BREAK_EVERY_MIN) * env.ESTIMATE_BREAK_MIN;
  const descansosMin = Math.floor((idaMin + vueltaMin) / env.ESTIMATE_BREAK_EVERY_MIN) * env.ESTIMATE_BREAK_MIN;

  // Hora de retiro: la cargada en el servicio; si falta, se deduce hacia atras desde la ETA (maximo de entrega).
  let inicioMs = record.fechaRetiro ? new Date(record.fechaRetiro).getTime() : null;
  const inicioInferido = inicioMs == null;
  if (inicioMs == null) {
    if (!record.eta) throw new AppError("El servicio no tiene hora de retiro ni ETA para estimar", 409);
    inicioMs = new Date(record.eta).getTime() - (idaMin + paradasMin + descansosHastaUltima) * MIN_MS;
  }

  const ultimaEntregaMs = inicioMs + (idaMin + paradasMin + descansosHastaUltima) * MIN_MS;
  const finMs = ultimaEntregaMs + (vueltaMin + (descansosMin - descansosHastaUltima)) * MIN_MS;

  const result = {
    calculadaAt: new Date().toISOString(),
    inicioAt: new Date(inicioMs).toISOString(),
    inicioInferido,
    salida: salida.direccion,
    destinoFinal: lastStop.direccion ?? record.destinazione ?? null,
    paradas: stops.length,
    ultimaEntregaAt: new Date(ultimaEntregaMs).toISOString(),
    finEstimadoAt: new Date(finMs).toISOString(),
    totalMin: Math.round((finMs - inicioMs) / MIN_MS),
    conduccionIdaMin: idaMin,
    conduccionVueltaMin: vueltaMin,
    paradasMin,
    descansosMin,
    distanciaIdaKm: distanciaIdaKm != null ? Math.round(distanciaIdaKm) : null,
    retorno: { direccion: retorno.direccion, nombre: retorno.nombre, fuente: retorno.fuente },
    factorTrafico: factor,
    minPorParada: env.ESTIMATE_STOP_MIN,
    descansoCadaMin: env.ESTIMATE_BREAK_EVERY_MIN,
    descansoMin: env.ESTIMATE_BREAK_MIN,
    rutaFuente: estimada || !back ? "estimada" : "ruta",
  };
  await updateRecordById(record.id, { estimacionRuta: result });
  return result;
};
