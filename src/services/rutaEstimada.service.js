import { BRENNERO } from "../constants/brennero.js";
import { defaultSalidaFor } from "../constants/salidaPorDefecto.js";
import { WORK_PLACES } from "../constants/workPlaces.js";
import { env } from "../config/env.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { findRecordById, updateRecordById } from "../models/record.model.js";
import { AppError } from "../utils/AppError.js";
import { distanceMeters, estimateDriveMinutes } from "../utils/stopDetection.js";
import { findGroupMembers } from "../models/compactado.model.js";
import { geocodeAddress } from "./geocoding.service.js";
import { agruparPagos, pagoTexto, peajeLabel, peajesEnRuta } from "./peajes.service.js";
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
  // "¿Pasa por Brennero?": en un viaje compacto basta con que lo marque uno de sus servicios.
  const brennero = members.some((m) => m.pasaPorBrennero);
  return { base, retiros, paradas, brennero };
};

// Ruta de ida (base -> retiros -> paradas) y de vuelta (ultima parada -> base). Si el chofer declaro que no uso peaje de ida o de
// vuelta, ese sentido se calcula sin autopistas de pago (sinPeaje). Sin servidor de rutas se estima en linea recta (con un factor), y
// queda marcado.
const routeLegs = async ({ base, retiros, paradas, brennero }, sinPeaje = {}) => {
  // Con Brennero, solo la ida pasa por ahi (antes de las paradas del exterior); la vuelta va directo al lugar de espera.
  const ida = [base, ...retiros, ...(brennero ? [BRENNERO] : []), ...paradas];
  const last = paradas[paradas.length - 1];
  const [idaRoute, backRoute] = await Promise.all([
    calculateRoute(ida, { evitarPeajes: Boolean(sinPeaje.ida) }),
    calculateRoute([last, base], { evitarPeajes: Boolean(sinPeaje.vuelta) }),
  ]);
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
    idaRoute,
    backRoute,
  };
};

// Que dijo el chofer sobre los peajes del circuito: en un viaje compacto se declara en cualquier servicio del viaje.
const sinPeajeOf = (members) => ({
  ida: members.some((m) => m.sinPeajeIda),
  vuelta: members.some((m) => m.sinPeajeVuelta),
});

// Peajes del catalogo por los que pasa cada sentido del circuito, para mostrarlos y para comprobar las rutas "sin peaje".
const peajesDeLegs = async (legs, sinPeaje) => {
  const [ida, vuelta] = await Promise.all([
    legs.idaRoute ? peajesEnRuta(legs.idaRoute.geometria) : [],
    legs.backRoute ? peajesEnRuta(legs.backRoute.geometria) : [],
  ]);
  const pagosIda = agruparPagos(ida);
  const pagosVuelta = agruparPagos(vuelta);
  return {
    // Lo que declaro el chofer (true = no uso peaje) y si la ruta calculada realmente lo evita.
    idaSinPeaje: sinPeaje.ida,
    vueltaSinPeaje: sinPeaje.vuelta,
    idaEvitado: sinPeaje.ida ? Boolean(legs.idaRoute?.evitoPeajes) : null,
    vueltaEvitado: sinPeaje.vuelta ? Boolean(legs.backRoute?.evitoPeajes) : null,
    // Pagos estimados (dos casetas de una misma autopista cerrada = un pago): "Milano Sud -> Bologna Casalecchio".
    ida: pagosIda.slice(0, 8).map(pagoTexto),
    vuelta: pagosVuelta.slice(0, 8).map(pagoTexto),
    idaCantidad: pagosIda.length,
    vueltaCantidad: pagosVuelta.length,
    // Casetas sueltas sin pareja: puede ser una barrera unica (sistema abierto) o falta la otra en el catalogo.
    idaRevisar: pagosIda.some((p) => p.tipo === "BARRERA_UNICA"),
    vueltaRevisar: pagosVuelta.some((p) => p.tipo === "BARRERA_UNICA"),
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
  const sinPeaje = sinPeajeOf(members);
  // Los peajes declarados entran en la firma: si el chofer cambia lo que declaro, el circuito se vuelve a calcular.
  const firma = [points.base, ...points.retiros, ...points.paradas].map(pointKey).join("|") + `|peaje:${sinPeaje.ida ? 1 : 0}${sinPeaje.vuelta ? 1 : 0}` + (points.brennero ? "|brennero" : "");
  // "idaRevisar" distingue el formato actual de los peajes (pagos) del anterior (casetas sueltas): los viejos se recalculan.
  if (!force && holder.circuito?.firma === firma && holder.circuito.tramos && holder.circuito.peajes && "idaRevisar" in holder.circuito.peajes) {
    return holder.circuito;
  }

  const legs = await routeLegs(points, sinPeaje);
  const circuito = {
    km: round1(legs.idaKm + legs.vueltaKm),
    idaKm: round1(legs.idaKm),
    idaMin: Math.round(legs.idaMin),
    vueltaKm: round1(legs.vueltaKm),
    vueltaMin: Math.round(legs.vueltaMin),
    base: { nombre: points.base.nombre, direccion: points.base.direccion },
    // Los tramos del circuito, en orden, para verificar la ruta: lugar de espera -> retiro -> paradas -> lugar de espera.
    tramos: [
      ...[...points.retiros, ...(points.brennero ? [BRENNERO] : []), ...points.paradas].map((to, i, all) => ({
        desde: i === 0 ? points.base.nombre : all[i - 1].direccion,
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
    peajes: await peajesDeLegs(legs, sinPeaje),
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

// Tiempos de un servicio para planificar la salida (o la llegada) de una reprogramacion, con las mismas reglas que la
// estimacion de arriba: tiempo de ruta x recargo de trafico, minutos fijos por parada y un descanso cada cierto tiempo de
// conduccion. Con la ETA devuelve a que hora conviene salir; con la salida, a que hora llegaria. null si no hay circuito.
export const planTiming = async (recordId, { eta = null, salida = null } = {}) => {
  const circuito = await ensureCircuit(recordId);
  const record = await findRecordById(recordId);
  if (!circuito || !record) return null;
  const factor = env.ESTIMATE_TRAFFIC_FACTOR;
  const idaMin = Math.round(circuito.idaMin * factor);
  const vueltaMin = Math.round(circuito.vueltaMin * factor);
  const paradasMin = (record.stops?.length ?? 1) * env.ESTIMATE_STOP_MIN;
  const descansosIdaMin = Math.floor(idaMin / env.ESTIMATE_BREAK_EVERY_MIN) * env.ESTIMATE_BREAK_MIN;
  const hastaEntregaMin = idaMin + paradasMin + descansosIdaMin;
  const descansosTotalMin = Math.floor((idaMin + vueltaMin) / env.ESTIMATE_BREAK_EVERY_MIN) * env.ESTIMATE_BREAK_MIN;
  const salidaMs = salida ? new Date(salida).getTime() : eta ? new Date(eta).getTime() - hastaEntregaMin * MIN_MS : null;
  const etaMs = eta ? new Date(eta).getTime() : salidaMs != null ? salidaMs + hastaEntregaMin * MIN_MS : null;
  return {
    salidaAt: salidaMs != null ? new Date(salidaMs).toISOString() : null,
    etaAt: etaMs != null ? new Date(etaMs).toISOString() : null,
    finEstimadoAt: etaMs != null ? new Date(etaMs + (vueltaMin + descansosTotalMin - descansosIdaMin) * MIN_MS).toISOString() : null,
    conduccionIdaMin: idaMin,
    conduccionVueltaMin: vueltaMin,
    paradasMin,
    descansosIdaMin,
    hastaEntregaMin,
    factorTrafico: factor,
    descansoCadaMin: env.ESTIMATE_BREAK_EVERY_MIN,
    descansoMin: env.ESTIMATE_BREAK_MIN,
    circuitoKm: circuito.km,
    rutaFuente: circuito.fuente === "estimada" ? "estimada" : "ruta",
  };
};

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
  const sinPeaje = sinPeajeOf(members);
  const ida = [points.base, ...points.retiros, ...(points.brennero ? [BRENNERO] : []), ...points.paradas];
  const last = points.paradas[points.paradas.length - 1];
  const [idaRoute, backRoute] = await Promise.all([
    calculateRoute(ida, { evitarPeajes: sinPeaje.ida }),
    calculateRoute([last, points.base], { evitarPeajes: sinPeaje.vuelta }),
  ]);
  const [peajesIda, peajesVuelta] = await Promise.all([
    idaRoute ? peajesEnRuta(idaRoute.geometria) : [],
    backRoute ? peajesEnRuta(backRoute.geometria) : [],
  ]);
  const ruta = (tipo, route, sin, peajes) => ({
    tipo,
    // El chofer declaro que no uso peaje en este sentido y la ruta dibujada lo evita (si no se pudo evitar, "evitado" es false).
    sinPeaje: sin,
    evitado: sin ? Boolean(route?.evitoPeajes) : null,
    geometria: route?.geometria ?? null,
    peajes: peajes.map((p) => ({ id: p.id, nombre: peajeLabel(p), operador: p.operador, tipo: p.tipo, lat: p.lat, lng: p.lng })),
    // Cuantos pagos son (entrada + salida = 1): ver agruparPagos.
    pagos: agruparPagos(peajes),
  });
  return {
    circuito,
    puntos: [
      { tipo: "SALIDA", nombre: points.base.nombre ?? "Lugar de espera", lat: points.base.lat, lng: points.base.lng },
      ...points.retiros.map((p) => ({ tipo: "RETIRO", nombre: p.direccion, lat: p.lat, lng: p.lng })),
      ...(points.brennero ? [{ tipo: "PASO", nombre: "Brennero", lat: BRENNERO.lat, lng: BRENNERO.lng }] : []),
      ...points.paradas.map((p) => ({ tipo: "PARADA", nombre: p.direccion ?? "Parada", lat: p.lat, lng: p.lng })),
      { tipo: "REGRESO", nombre: points.base.nombre ?? "Lugar de espera", lat: points.base.lat, lng: points.base.lng },
    ],
    // Ida y vuelta por separado: cada una con su propia ruta (con o sin peaje) y los peajes que cruza.
    rutas: [ruta("IDA", idaRoute, sinPeaje.ida, peajesIda), ruta("VUELTA", backRoute, sinPeaje.vuelta, peajesVuelta)],
    geometria:
      idaRoute?.geometria && backRoute?.geometria
        ? { type: "LineString", coordinates: [...idaRoute.geometria.coordinates, ...backRoute.geometria.coordinates] }
        : (idaRoute?.geometria ?? null),
  };
};
