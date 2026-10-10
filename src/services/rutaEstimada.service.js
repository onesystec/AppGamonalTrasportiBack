import { defaultSalidaFor } from "../constants/salidaPorDefecto.js";
import { WORK_PLACES } from "../constants/workPlaces.js";
import { env } from "../config/env.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { findRecordById, updateRecordById } from "../models/record.model.js";
import { AppError } from "../utils/AppError.js";
import { distanceMeters, estimateDriveMinutes } from "../utils/stopDetection.js";
import { findGroupMembers } from "../models/compactado.model.js";
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
  // Roma tiene dos lugares de espera: el de DHL Roma y el de Extras Piazza Roma (Cargo City).
  if (record.extrasPiazzaZona === "ROMA") {
    return record.spedizzione === "DHL" ? placeByName("Lugar de espera Roma") : placeByName("Lugar de espera Roma (Extras Piazza)");
  }
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

export const resolveReturn = async (record) => {
  const place = areaReturnPlace(record);
  if (place) return { nombre: place.nombre, direccion: place.direccion, lat: place.lat, lng: place.lng, fuente: "area" };
  const configured = await readReturnConfig();
  if (configured) {
    return { nombre: "la direccion de retorno", direccion: configured.direccion, lat: configured.lat, lng: configured.lng, fuente: "configurada" };
  }
  const fallback = DEFAULT_RETURN_PLACE();
  return { nombre: fallback.nombre, direccion: fallback.direccion, lat: fallback.lat, lng: fallback.lng, fuente: "por defecto" };
};

// ------------------------------------------------------------------- circuito del servicio (o del viaje)

// Todo servicio sale del lugar de espera, pasa por el retiro, entrega y vuelve al lugar de espera:
//   lugar de espera -> retiro -> paradas -> lugar de espera
// En un viaje compacto es UN solo circuito: el vehiculo no vuelve al lugar de espera entre una entrega y la
// siguiente, va directo a la proxima parada y recien despues de la ultima vuelve.
const CIRCUIT_SAME_PLACE_M = 150;
const round1 = (value) => Math.round(value * 10) / 10;
const pointKey = (p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
const straightKm = (a, b) => (distanceMeters(a, b) * 1.35) / 1000;

const pickupOf = (record) =>
  record.salidaLat != null && record.salidaLng != null
    ? { direccion: record.salidaDireccion ?? "Salida", lat: record.salidaLat, lng: record.salidaLng }
    : (({ direccion, lat, lng }) => ({ direccion, lat, lng }))(defaultSalidaFor(record));

// Los servicios del circuito: el propio, o todos los del viaje compacto en el orden de las paradas.
const unitOf = async (record) => {
  if (!record.compactadoId) return [record];
  const ids = (await findGroupMembers(record.compactadoId)).map((m) => m.id);
  const members = await Promise.all(ids.map((id) => (id === record.id ? record : findRecordById(id))));
  return members.filter(Boolean);
};

const placedStops = (record) =>
  (record.stops ?? []).filter((s) => s.lat != null && s.lng != null).sort((a, b) => a.orden - b.orden);

// Puntos del circuito: base (lugar de espera), retiros distintos (uno solo si todos retiran en el mismo lugar) y
// paradas de todos los servicios en orden. null si alguna parada no esta ubicada en el mapa.
const circuitPoints = async (members) => {
  if (members.some((m) => (m.stops ?? []).length === 0 || placedStops(m).length !== m.stops.length)) return null;
  const base = await resolveReturn(members[0]);
  const retiros = [];
  for (const m of members) {
    const pickup = pickupOf(m);
    if (!retiros.some((r) => distanceMeters(r, pickup) <= CIRCUIT_SAME_PLACE_M)) retiros.push(pickup);
  }
  const paradas = members.flatMap(placedStops);
  return { base, retiros, paradas };
};

// Ruta de ida (base -> retiros -> paradas) y de vuelta (ultima parada -> base). Sin servidor de rutas se estima en
// linea recta (con un factor), y queda marcado.
const routeLegs = async ({ base, retiros, paradas }) => {
  const ida = [base, ...retiros, ...paradas];
  const last = paradas[paradas.length - 1];
  const [idaRoute, backRoute] = await Promise.all([calculateRoute(ida), calculateRoute([last, base])]);
  const estimada = !idaRoute || !backRoute;
  // Cada tramo del circuito, en orden: base -> retiro(s) -> paradas -> base (sin ruta, en linea recta con un factor).
  const tramosIda = ida.slice(1).map((to, i) => ({
    km: idaRoute?.tramos?.[i]?.distanciaKm ?? straightKm(ida[i], to),
    min: idaRoute?.tramos?.[i]?.duracionMin ?? estimateDriveMinutes(ida[i], to),
  }));
  return {
    idaKm: idaRoute ? idaRoute.distanciaKm : tramosIda.reduce((sum, t) => sum + t.km, 0),
    idaMin: idaRoute ? idaRoute.duracionMin : tramosIda.reduce((sum, t) => sum + t.min, 0),
    vueltaKm: backRoute ? backRoute.distanciaKm : straightKm(last, base),
    vueltaMin: backRoute ? backRoute.duracionMin : estimateDriveMinutes(last, base),
    tramosIda,
    estimada,
  };
};

// Circuito planificado del servicio o, si va en un viaje compacto, de todo el viaje (se guarda en el servicio
// principal, columna "circuito"). Se recalcula solo si cambiaron los puntos (firma). null si no se puede (traspaso
// entre choferes, paradas sin ubicar). Es la referencia para validar los km y las horas que declara el chofer.
export const ensureCircuit = async (recordId, { force = false } = {}) => {
  const record = await findRecordById(recordId);
  if (!record || record.servicioOrigenId || record.continuaciones?.length) return null;
  const members = await unitOf(record);
  if (members.some((m) => m.servicioOrigenId || m.continuaciones?.length)) return null;
  const points = await circuitPoints(members);
  if (!points) return null;

  const holder = members[0];
  const firma = [points.base, ...points.retiros, ...points.paradas].map(pointKey).join("|");
  if (!force && holder.circuito?.firma === firma && holder.circuito.tramos) return holder.circuito;

  const legs = await routeLegs(points);
  const circuito = {
    km: round1(legs.idaKm + legs.vueltaKm),
    idaKm: round1(legs.idaKm),
    idaMin: Math.round(legs.idaMin),
    vueltaKm: round1(legs.vueltaKm),
    vueltaMin: Math.round(legs.vueltaMin),
    base: { nombre: points.base.nombre, direccion: points.base.direccion },
    // Los tramos del circuito, en orden, para verificar la ruta: lugar de espera -> retiro -> paradas -> lugar de espera.
    tramos: [
      ...[...points.retiros, ...points.paradas].map((to, i) => ({
        desde: i === 0 ? points.base.nombre : [...points.retiros, ...points.paradas][i - 1].direccion,
        hasta: to.direccion,
        km: round1(legs.tramosIda[i].km),
        min: Math.round(legs.tramosIda[i].min),
      })),
      {
        desde: points.paradas[points.paradas.length - 1].direccion,
        hasta: points.base.nombre,
        km: round1(legs.vueltaKm),
        min: Math.round(legs.vueltaMin),
      },
    ],
    retiros: points.retiros.map((p) => p.direccion),
    paradas: points.paradas.map((p) => p.direccion ?? null),
    servicios: members.map((m) => m.codigo),
    firma,
    fuente: legs.estimada ? "estimada" : "ruta",
    calculadaAt: new Date().toISOString(),
  };
  // El total es la suma de los tramos que se muestran (asi lo que se ve en pantalla siempre suma).
  circuito.km = round1(circuito.tramos.reduce((sum, t) => sum + t.km, 0));
  await updateRecordById(holder.id, { circuito });
  return circuito;
};

// Igual, sin romper nunca el flujo que lo llama.
export const ensureCircuitSafe = (recordId, options) =>
  ensureCircuit(recordId, options).catch((err) => {
    console.error("No se pudo calcular el circuito del servicio:", err.message);
    return null;
  });

export const computeEstimacionForRecord = async (recordId) => {
  const record = await findRecordById(recordId);
  if (!record) throw new AppError("Registro no encontrado", 404);
  if (record.servicioOrigenId || record.continuaciones?.length) {
    throw new AppError("Un servicio traspasado entre choferes no se puede estimar por ruta", 409);
  }

  const members = await unitOf(record);
  const points = await circuitPoints(members);
  if (!points) throw new AppError("El servicio no tiene paradas ubicadas en el mapa", 409);
  const circuito = await ensureCircuit(recordId);

  const factor = env.ESTIMATE_TRAFFIC_FACTOR;
  const paradas = points.paradas;
  const lastStop = paradas[paradas.length - 1];
  const retorno = points.base;

  const idaMin = Math.round(circuito.idaMin * factor);
  const vueltaMin = Math.round(circuito.vueltaMin * factor);
  const paradasMin = paradas.length * env.ESTIMATE_STOP_MIN;
  const descansosHastaUltima = Math.floor(idaMin / env.ESTIMATE_BREAK_EVERY_MIN) * env.ESTIMATE_BREAK_MIN;
  const descansosMin = Math.floor((idaMin + vueltaMin) / env.ESTIMATE_BREAK_EVERY_MIN) * env.ESTIMATE_BREAK_MIN;

  // Hora de salida del lugar de espera: la "Fecha retiro" cargada; si falta, se deduce hacia atras desde la ETA (maximo
  // de entrega) del ultimo servicio del viaje.
  const lastMember = members[members.length - 1];
  const holder = members[0];
  let inicioMs = holder.fechaRetiro ? new Date(holder.fechaRetiro).getTime() : null;
  const inicioInferido = inicioMs == null;
  if (inicioMs == null) {
    if (!lastMember.eta) throw new AppError("El servicio no tiene hora de retiro ni ETA para estimar", 409);
    inicioMs = new Date(lastMember.eta).getTime() - (idaMin + paradasMin + descansosHastaUltima) * MIN_MS;
  }

  const ultimaEntregaMs = inicioMs + (idaMin + paradasMin + descansosHastaUltima) * MIN_MS;
  const finMs = ultimaEntregaMs + (vueltaMin + (descansosMin - descansosHastaUltima)) * MIN_MS;

  const result = {
    calculadaAt: new Date().toISOString(),
    inicioAt: new Date(inicioMs).toISOString(),
    inicioInferido,
    // Circuito completo: sale del lugar de espera, retira, entrega todas las paradas (en un viaje compacto, sin volver
    // entre una y otra) y vuelve.
    salida: retorno.nombre ?? retorno.direccion,
    retiros: points.retiros.map((p) => p.direccion),
    viaje: members.length > 1 ? members.map((m) => m.codigo) : null,
    destinoFinal: lastStop.direccion ?? lastMember.destinazione ?? null,
    paradas: paradas.length,
    ultimaEntregaAt: new Date(ultimaEntregaMs).toISOString(),
    finEstimadoAt: new Date(finMs).toISOString(),
    totalMin: Math.round((finMs - inicioMs) / MIN_MS),
    conduccionIdaMin: idaMin,
    conduccionVueltaMin: vueltaMin,
    paradasMin,
    descansosMin,
    distanciaIdaKm: Math.round(circuito.idaKm),
    circuitoKm: circuito.km,
    retorno: { direccion: retorno.direccion, nombre: retorno.nombre, fuente: retorno.fuente },
    factorTrafico: factor,
    minPorParada: env.ESTIMATE_STOP_MIN,
    descansoCadaMin: env.ESTIMATE_BREAK_EVERY_MIN,
    descansoMin: env.ESTIMATE_BREAK_MIN,
    rutaFuente: circuito.fuente === "estimada" ? "estimada" : "ruta",
  };
  await updateRecordById(record.id, { estimacionRuta: result });
  return result;
};

// Todo lo que hace falta para dibujar el circuito en un mapa y comprobar que es correcto: los puntos en orden (salida,
// retiro, paradas, regreso), el recorrido por calles y el detalle de km de cada tramo.
export const getCircuitMapData = async (recordId) => {
  const circuito = await ensureCircuit(recordId);
  if (!circuito) return null;
  const record = await findRecordById(recordId);
  const members = await unitOf(record);
  const points = await circuitPoints(members);
  if (!points) return null;
  const todos = [points.base, ...points.retiros, ...points.paradas, points.base];
  const route = await calculateRoute(todos);
  return {
    circuito,
    puntos: [
      { tipo: "SALIDA", nombre: points.base.nombre ?? "Lugar de espera", lat: points.base.lat, lng: points.base.lng },
      ...points.retiros.map((p) => ({ tipo: "RETIRO", nombre: p.direccion, lat: p.lat, lng: p.lng })),
      ...points.paradas.map((p) => ({ tipo: "PARADA", nombre: p.direccion ?? "Parada", lat: p.lat, lng: p.lng })),
      { tipo: "REGRESO", nombre: points.base.nombre ?? "Lugar de espera", lat: points.base.lat, lng: points.base.lng },
    ],
    geometria: route?.geometria ?? null,
  };
};
