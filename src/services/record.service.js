import {
  createRecord as createRecordModel,
  deleteRecordById,
  findRecordById,
  findRecords,
  findRecordsResumen,
  findRecordsForExport,
  findRecordsPending,
  findRecordsSummary,
  findRecordsWithSyncFailure,
  releaseCombustiblesOfRecord,
  releaseMancatosOfRecord,
  searchRecords,
  updateRecordById,
} from "../models/record.model.js";
import { findUserById, findUserLocationById } from "../models/user.model.js";
import { purgeFilesForRecord } from "./recordFile.service.js";
import { rematchAssignmentsForVehicle } from "./assignmentRematch.service.js";
import { syncRelevoForRecord } from "./traspaso.service.js";
import { groupFuelByRecord } from "../models/combustible.model.js";
import { groupMancatosByRecord } from "../models/mancato.model.js";
import { computeFaltantes } from "../utils/faltantes.js";
import { effectiveFuel, fuelNeedsAudit } from "../utils/fuelCost.js";
import { geocodeAddress, geocodeStops } from "./geocoding.service.js";
import { calculateRoute } from "./routing.service.js";
import { LOCATION_FRESH_MINUTES } from "./user.service.js";
import { getFreshVehiclePositionByTarga } from "./velocityFleet.service.js";
import { env } from "../config/env.js";
import {
  appendRecordToAppsheet,
  deleteRecordFromAppsheet,
  updateRecordInAppsheet,
} from "./appsheetWriteback.service.js";
import { DEPOT_ORIGIN } from "../constants/depot.js";
import { ORIGEN_PREFIX, toRomeParts } from "../constants/appsheetMaps.js";
import { canAccessRecordArea, recordAreaWhere } from "../utils/areaAccess.js";
import { AppError } from "../utils/AppError.js";
import { buildLocalDateRange } from "../utils/dateRange.js";

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

// Un Responsable (ADMIN) solo ve/gestiona los servicios de las areas que el Admin le marco
// (User.areasPermitidas, ver utils/areaAccess.js); el Admin (OWNER) no tiene restriccion. Sin ninguna
// area marcada no ve ningun servicio: deny-by-default.
export const spedizzioneFilterForActor = (actor) => recordAreaWhere(actor);

// Filtro de las listas y conteos que usa la oficina: ademas del area del actor, solo los servicios
// originales. El segundo tramo de un traspaso entre choferes (la "continuacion") no es un servicio
// mas para el cliente ni para los totales: se ve desde su servicio original.
const listFilterForActor = (actor) =>
  isPrivileged(actor)
    ? { ...(spedizzioneFilterForActor(actor) ?? {}), servicioOrigenId: null }
    : spedizzioneFilterForActor(actor);


export const assertAccess = (actor, record) => {
  if (actor.cargo === "OWNER" || record.driverId === actor.id) return;
  if (isPrivileged(actor) && canAccessRecordArea(actor, record)) return;
  throw new AppError("No tienes permisos para realizar esta accion", 403);
};

const assertDriverActivo = async (driverId) => {
  const driver = await findUserById(driverId);
  if (!driver || driver.estado !== "ACTIVO") {
    throw new AppError("El conductor indicado no existe o esta inactivo", 400);
  }
};

// Campos operativos que un CHOFER puede editar en su propio record; el resto (economico,
// relaciones, etc.) se ignora si viene de un CHOFER, igual que SELF_EDITABLE_FIELDS en user.service.js.
const SELF_EDITABLE_FIELDS = [
  "horasDia",
  "horasNoche",
  "tiempoEspera",
  "estado",
  "comentarios",
  "kilometrosReales",
  "sinPeajeIda",
  "sinPeajeVuelta",
  "sinCombustible",
];

// Campos de un servicio que deciden a que servicio pertenece un peaje (ver
// mancatoMatching.service.js). "stops" cambia la duracion de la ruta.
const RELEVANT_FOR_MATCHING = [
  "fechaRetiro",
  "fechaServicio",
  "eta",
  "vehicleId",
  "driverId",
  "estado",
  "stops",
  "rutaDuracionMin",
];

// Punto de salida de un servicio: el elegido en el formulario o, si nunca se eligio, el deposito.
const salidaOf = (record) =>
  record.salidaLat != null && record.salidaLng != null
    ? { direccion: record.salidaDireccion ?? "Salida", lat: record.salidaLat, lng: record.salidaLng }
    : { direccion: DEPOT_ORIGIN.direccion, lat: DEPOT_ORIGIN.lat, lng: DEPOT_ORIGIN.lng };

// De lo que manda el formulario ({ direccion, lat?, lng? }) al punto con coordenadas. Con coordenadas
// (sugerencia con ubicacion exacta) no se geocodifica; sin ellas se geocodifica el texto, y si no se
// encuentra se avisa en vez de aproximar a la ciudad: una salida mal ubicada cambia toda la ruta.
const resolveSalida = async (input) => {
  if (!input) return null;
  if (input.lat != null && input.lng != null) {
    return { direccion: input.direccion, lat: input.lat, lng: input.lng };
  }
  const { lat, lng } = await geocodeAddress(input.direccion);
  return { direccion: input.direccion, lat, lng };
};

const salidaColumns = (salida) => ({
  salidaDireccion: salida?.direccion ?? null,
  salidaLat: salida?.lat ?? null,
  salidaLng: salida?.lng ?? null,
});

// Geocodifica las paradas (en orden) y calcula la ruta salida -> paradas. Devuelve
// el payload listo para mezclar en la data que se manda a Prisma. fallbackCiudad: si
// una parada no geocodifica, geocodeStops la aproxima al centro de esa ciudad en vez
// de fallar el registro entero (ver geocoding.service.js).
const buildStopsPipeline = async (direcciones, fallbackCiudad, salida = DEPOT_ORIGIN) => {
  const stopsGeocoded = await geocodeStops(direcciones, fallbackCiudad);
  const ruta = await calculateRoute([salida, ...stopsGeocoded]);

  return {
    stopsCreate: stopsGeocoded.map((s, i) => ({
      orden: i,
      direccion: s.direccion,
      lat: s.lat,
      lng: s.lng,
      geocodedAt: new Date(),
    })),
    destinazione: stopsGeocoded[stopsGeocoded.length - 1].direccion,
    rutaDistanciaKm: ruta?.distanciaKm ?? null,
    rutaDuracionMin: ruta?.duracionMin ?? null,
    rutaGeometria: ruta?.geometria ?? null,
    rutaCalculadaAt: ruta ? new Date() : null,
  };
};

const stopsUnchanged = (existingStops, direcciones) =>
  existingStops.length === direcciones.length &&
  existingStops.every(
    (stop, i) => stop.direccion.trim().toLowerCase() === direcciones[i].trim().toLowerCase()
  );

// Traspaso entre choferes. Del lado del servicio original: quien lo termino ("relevo"); del lado de
// la continuacion: de quien lo recibio ("origen").
const toRelevo = (record) => {
  const next = record.continuaciones?.[0];
  return next
    ? {
        recordId: next.id,
        codigo: next.codigo,
        driverId: next.driverId,
        chofer: next.driver,
        traspasoHora: next.traspasoHora ?? null,
        estado: next.estado,
      }
    : null;
};
const toOrigen = (record) =>
  record.servicioOrigen
    ? {
        recordId: record.servicioOrigen.id,
        codigo: record.servicioOrigen.codigo,
        chofer: record.servicioOrigen.driver,
        finJornada: record.servicioOrigen.horaFinReal ?? null,
      }
    : null;

// Jornada declarada por el chofer y su estado de aprobacion (ver utils/workHours.js).
// "esperaMin" se reconstruye de tiempoEspera (horas) para que el formulario trabaje en minutos.
export const toJornada = (record) => ({
  inicio: record.horaInicioReal ?? null,
  fin: record.horaFinReal ?? null,
  pausaMin: record.pausaMin ?? 0,
  esperaMin: record.tiempoEspera ? Math.round(record.tiempoEspera * 60) : 0,
  horasDia: record.horasDia ?? null,
  horasNoche: record.horasNoche ?? null,
  estado: record.horasEstado ?? null,
  enviadasAt: record.horasEnviadasAt ?? null,
  revisadasAt: record.horasRevisadasAt ?? null,
  nota: record.horasNota ?? null,
  declaradas: record.horasDeclaradas ?? null,
  finFueraDeBase: record.finFueraDeBase ?? false,
});

// Resumen de combustible de un servicio. En el detalle trae los comprobantes ("combustibles");
// en los listados solo la suma y la cantidad (ver attachFuel).
const toFuelSummary = (record) => {
  const items = record.combustibles;
  const receiptsCount = items ? items.length : (record.fuelCount ?? 0);
  const receiptsTotal = items ? items.reduce((sum, c) => sum + Number(c.monto), 0) : (record.fuelSum ?? 0);
  const manual = record.costoCombustible ?? null;
  const { fuente, total } = effectiveFuel({ manual, receiptsTotal, receiptsCount });
  return {
    fuente,
    total,
    manual,
    comprobantes: {
      count: receiptsCount,
      total: Math.round(receiptsTotal * 100) / 100,
      items: items?.map((c) => ({
        id: c.id,
        monto: Number(c.monto),
        fechaHora: c.fechaHora,
        metodo: c.metodo,
        asignacion: c.asignacion,
      })),
    },
    // El valor a mano es casi el doble o mas de lo que suman los comprobantes: a auditar.
    auditar: fuelNeedsAudit({ manual, receiptsTotal, receiptsCount }),
  };
};

// Suma y cantidad de comprobantes por servicio para los listados (sin traer cada comprobante).
// Tambien deja los peajes asignados por tramo, para saber a que servicios les falta subir uno.
const attachFuel = async (records) => {
  if (records.length === 0) return records;
  const [groups, mancatoGroups] = await Promise.all([groupFuelByRecord(), groupMancatosByRecord()]);
  const byRecord = new Map(groups.map((g) => [g.recordId, g]));
  const mancatosByRecord = new Map();
  for (const g of mancatoGroups) {
    const entry = mancatosByRecord.get(g.recordId) ?? { mancatoIda: 0, mancatoVuelta: 0, mancatoSinTramo: 0 };
    if (g.tramo === "IDA") entry.mancatoIda += g._count._all;
    else if (g.tramo === "VUELTA") entry.mancatoVuelta += g._count._all;
    else entry.mancatoSinTramo += g._count._all;
    mancatosByRecord.set(g.recordId, entry);
  }
  for (const record of records) {
    const group = byRecord.get(record.id);
    record.fuelSum = Number(group?._sum.monto ?? 0);
    record.fuelCount = group?._count._all ?? 0;
    record.faltantesCounts = {
      ...(mancatosByRecord.get(record.id) ?? { mancatoIda: 0, mancatoVuelta: 0, mancatoSinTramo: 0 }),
      combustibles: record.fuelCount,
    };
  }
  return records;
};

// Que le falta subir al servicio (peajes de ida/vuelta, combustible). Si el listado no trajo los datos para
// saberlo, null: mejor no marcar nada que marcar en rojo por error.
const faltantesOf = (record) =>
  record.mancatos || record.faltantesCounts ? computeFaltantes(record, record.faltantesCounts) : null;

// Peajes asignados a un servicio (solo en el detalle; el listado no los trae).
const toMancatosSummary = (mancatos) =>
  mancatos?.map((m) => ({
    id: m.id,
    numero: m.numero,
    fechaHoraTransito: m.fechaHoraTransito,
    tramo: m.tramo,
    asignacion: m.asignacion,
    costo: Number(m.costo),
    pagado: m.pagado,
  }));

const computeTotals = (record) => {
  const kilometros = record.kilometros ?? 0;
  const precioKm = record.precioKm ?? 0;
  const totalKm = kilometros * precioKm;

  // costoCombustible y pagoRecibido quedan fuera del total a proposito.
  const total =
    totalKm +
    (record.areaC ?? 0) +
    (record.costoEspera ?? 0) +
    (record.costoTraforoFrejusBrennero ?? 0) +
    (record.peajes ?? 0) +
    (record.vignetta ?? 0) +
    (record.costoHotel ?? 0) +
    (record.costoOtros ?? 0);

  return { totalKm, total };
};

// Diferencia entre lo que reporto el chofer y lo que se planifico, para que
// OWNER/ADMIN puedan detectar desvios. null si todavia no hay dato real cargado.
const computeKmDiff = (record) =>
  record.kilometrosReales != null && record.kilometros != null
    ? record.kilometrosReales - record.kilometros
    : null;

const toFullResponse = (record) => {
  const { totalKm, total } = computeTotals(record);
  return {
    id: record.id,
    estado: record.estado,
    driver: record.driver,
    vehicle: record.vehicle,
    client: record.client,
    fechaServicio: record.fechaServicio,
    eta: record.eta,
    fechaRetiro: record.fechaRetiro,
    mancatos: toMancatosSummary(record.mancatos),
    faltantes: faltantesOf(record),
    descripcion: record.descripcion,
    codigo: record.codigo,
    destinazione: record.destinazione,
    ciudad: record.ciudad,
    aplicativo: record.aplicativo,
    spedizzione: record.spedizzione,
    extrasPiazzaZona: record.extrasPiazzaZona,
    salida: salidaOf(record),
    // record.stops es undefined en los resultados de listado (findRecords no trae
    // la relacion, ver RECORD_SELECT_LIST) - solo esta presente en un fetch de un
    // registro puntual (findRecordById).
    stops: record.stops?.map(({ id, orden, direccion, lat, lng }) => ({ id, orden, direccion, lat, lng })),
    ruta: {
      distanciaKm: record.rutaDistanciaKm,
      duracionMin: record.rutaDuracionMin,
      geometria: record.rutaGeometria ?? null,
    },
    horasDia: record.horasDia,
    horasNoche: record.horasNoche,
    tiempoEspera: record.tiempoEspera,
    jornada: toJornada(record),
    relevo: toRelevo(record),
    origen: toOrigen(record),
    traspasoHora: record.traspasoHora ?? null,
    comentarios: record.comentarios,
    kilometros: record.kilometros,
    kilometrosReales: record.kilometrosReales,
    diferenciaKm: computeKmDiff(record),
    precioKm: record.precioKm,
    totalKm,
    areaC: record.areaC,
    costoEspera: record.costoEspera,
    costoTraforoFrejusBrennero: record.costoTraforoFrejusBrennero,
    peajes: record.peajes,
    vignetta: record.vignetta,
    costoHotel: record.costoHotel,
    costoOtros: record.costoOtros,
    pagoRecibido: record.pagoRecibido,
    // Combustible efectivo (comprobantes si hay, si no el valor a mano), nunca la suma de ambos.
    // "costoCombustibleManual" es lo que se escribio en el formulario del servicio.
    costoCombustible: toFuelSummary(record).total,
    costoCombustibleManual: record.costoCombustible,
    combustible: toFuelSummary(record),
    clienteConfirmado: record.clienteConfirmado,
    total,
    appsheetSyncFallido: record.appsheetSyncFallido,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

// Version liviana para el dashboard del Admin: los mismos valores que toFullResponse para los campos que
// el dashboard usa (verificado comparando la pantalla con ambas versiones), sin el resto.
const toResumenResponse = (record) => {
  const { total } = computeTotals(record);
  const fuel = toFuelSummary(record);
  return {
    id: record.id,
    estado: record.estado,
    driver: record.driver,
    vehicle: record.vehicle,
    client: record.client,
    fechaServicio: record.fechaServicio,
    eta: record.eta,
    codigo: record.codigo,
    destinazione: record.destinazione,
    spedizzione: record.spedizzione,
    extrasPiazzaZona: record.extrasPiazzaZona,
    horasDia: record.horasDia,
    horasNoche: record.horasNoche,
    kilometros: record.kilometros,
    kilometrosReales: record.kilometrosReales,
    areaC: record.areaC,
    costoEspera: record.costoEspera,
    costoTraforoFrejusBrennero: record.costoTraforoFrejusBrennero,
    peajes: record.peajes,
    vignetta: record.vignetta,
    costoHotel: record.costoHotel,
    costoOtros: record.costoOtros,
    pagoRecibido: record.pagoRecibido,
    costoCombustible: fuel.total,
    combustible: fuel,
    total,
    appsheetSyncFallido: record.appsheetSyncFallido,
    createdAt: record.createdAt,
  };
};

// Vista para CHOFER: sin campos economicos, salvo "kilometros" (solo lectura, lo que se
// planifico) y "kilometrosReales" (lo que el propio chofer carga) para que pueda compararlos.
const toChoferResponse = (record) => ({
  id: record.id,
  estado: record.estado,
  driver: record.driver,
  vehicle: record.vehicle,
  client: record.client,
  fechaServicio: record.fechaServicio,
  eta: record.eta,
  fechaRetiro: record.fechaRetiro,
  mancatos: toMancatosSummary(record.mancatos),
  faltantes: faltantesOf(record),
  descripcion: record.descripcion,
  codigo: record.codigo,
  destinazione: record.destinazione,
  ciudad: record.ciudad,
  aplicativo: record.aplicativo,
  spedizzione: record.spedizzione,
  extrasPiazzaZona: record.extrasPiazzaZona,
  salida: salidaOf(record),
  stops: record.stops?.map(({ id, orden, direccion, lat, lng }) => ({ id, orden, direccion, lat, lng })),
  ruta: {
    distanciaKm: record.rutaDistanciaKm,
    duracionMin: record.rutaDuracionMin,
    geometria: record.rutaGeometria ?? null,
  },
  horasDia: record.horasDia,
  horasNoche: record.horasNoche,
  tiempoEspera: record.tiempoEspera,
  jornada: toJornada(record),
  relevo: toRelevo(record),
  origen: toOrigen(record),
  traspasoHora: record.traspasoHora ?? null,
  comentarios: record.comentarios,
  kilometros: record.kilometros,
  kilometrosReales: record.kilometrosReales,
  appsheetSyncFallido: record.appsheetSyncFallido,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const toResponse = (record, actor) => (isPrivileged(actor) ? toFullResponse(record) : toChoferResponse(record));

// skipActiveCheck: solo para el sync de AppSheet (ver appsheetSync.service.js) - esos
// registros son historicos (servicios que ya pasaron), no una asignacion nueva, asi
// que no tiene sentido bloquear la carga porque el chofer hoy este INACTIVO. La API
// normal de creacion de registros sigue exigiendo chofer activo.
export const createRecord = async (data, { skipActiveCheck = false, actor = null } = {}) => {
  if (!skipActiveCheck) await assertDriverActivo(data.driverId);

  // actor=null (sync de AppSheet) no valida area: es un proceso de confianza que
  // importa historico de todas las areas, no una creacion manual desde la UI.
  if (actor && !canAccessRecordArea(actor, { spedizzione: data.spedizzione ?? null, extrasPiazzaZona: data.extrasPiazzaZona ?? null })) {
    throw new AppError("No tienes permisos para crear un registro fuera de tu area", 403);
  }

  const { stops: direcciones, salida: salidaInput, ...rest } = data;
  const salida = await resolveSalida(salidaInput);
  const { stopsCreate, destinazione, rutaDistanciaKm, rutaDuracionMin, rutaGeometria, rutaCalculadaAt } =
    await buildStopsPipeline(direcciones, data.ciudad, salida ?? DEPOT_ORIGIN);

  let record = await createRecordModel({
    ...rest,
    ...(salida ? salidaColumns(salida) : {}),
    destinazione,
    rutaDistanciaKm,
    rutaDuracionMin,
    rutaGeometria,
    rutaCalculadaAt,
    stops: { create: stopsCreate },
    estado: data.estado ?? "IN_SOSPESO",
    clienteConfirmado: data.clienteConfirmado ?? false,
  });

  // Solo para registros nuevos creados desde la app (el sync ya manda origenExternoId
  // seteado, escribirlo de vuelta a la hoja seria redundante - ver appsheetSync.service.js).
  // Best-effort: si falla la escritura en Sheets (permisos, red, cuota), el registro en
  // la app ya quedo creado igual, no se corta el flujo del usuario por eso - pero se deja
  // appsheetSyncFallido=true marcado en el registro para que la UI avise (ver
  // computeAppsheetSyncAlerts) en vez de perderse en silencio como antes.
  // DHL Roma no entra a este bloque: appendRecordToAppsheet no escribe nada para esa
  // zona a proposito (ver appsheetWriteback.service.js) - si igual se marcara
  // origenExternoId aca, quedaria apuntando a una fila que nunca existio en la hoja.
  const isDhlRoma = record.spedizzione === "DHL" && record.extrasPiazzaZona === "ROMA";
  if (!data.origenExternoId && !isDhlRoma) {
    try {
      await appendRecordToAppsheet(record);
      record = await updateRecordById(record.id, {
        origenExternoId: `${ORIGEN_PREFIX}${record.id}`,
        appsheetSyncFallido: false,
      });
    } catch (err) {
      console.error("No se pudo escribir el registro en la hoja de AppSheet:", err.message);
      record = await updateRecordById(record.id, { appsheetSyncFallido: true }).catch(() => record);
    }
  }

  // Los choferes suelen subir un peaje antes de que la oficina cargue el servicio: ahora que
  // existe, los mancatos "en espera" de este vehiculo se vuelven a evaluar.
  await rematchAssignmentsForVehicle(record.vehicleId);

  return toFullResponse(record);
};

// "Extras Piazza" en la planilla/historico no siempre tiene spedizzione cargada (ver
// areaAccess.js) - si el usuario pide esa seccion en el export, hay
// que matchear tambien spedizzione null, no solo el string "EXTRA_PIAZZA".
const seccionesToWhere = (secciones) => {
  if (!secciones?.length) return undefined;
  if (secciones.includes("EXTRA_PIAZZA")) {
    return { OR: [{ spedizzione: null }, { spedizzione: { in: secciones } }] };
  }
  return { spedizzione: { in: secciones } };
};

const timeToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Filtra por hora de pared en Italia (no UTC crudo, ver toRomeParts), usando ETA y no
// fechaServicio - fechaServicio no lleva hora real para los registros sincronizados
// desde AppSheet (siempre queda en medianoche, ver comentario en
// appsheetSync.service.js), asi que filtrar por su hora dejaria afuera casi todo el
// historico. Soporta rango que cruza medianoche (ej. 22:00 a 06:00 de un turno
// nocturno): si fromMin > toMin se interpreta como wraparound en vez de un rango vacio.
const matchesTimeRange = (record, fromTime, toTime) => {
  if (!fromTime && !toTime) return true;
  const { hour, minute } = toRomeParts(record.eta);
  const minutes = hour * 60 + minute;
  const fromMin = fromTime ? timeToMinutes(fromTime) : 0;
  const toMin = toTime ? timeToMinutes(toTime) : 23 * 60 + 59;
  return fromMin <= toMin ? minutes >= fromMin && minutes <= toMin : minutes >= fromMin || minutes <= toMin;
};

// Export CSV de Registros (boton "Exportar CSV" en Registros, solo OWNER/ADMIN - la
// ruta ya lo exige, pero igual se respeta el area del ADMIN como en cualquier otro
// listado). Devuelve los registros filtrados en el mismo shape de siempre
// (toFullResponse) - el archivo CSV en si se arma en el frontend, aca solo se filtra.
export const exportRecordsForActor = async (actor, filters) => {
  const { from, to, fromTime, toTime, driverId, clientId, vehicleId, secciones, zonas, estados } = filters;

  // [gte, lt) en UTC, mismo criterio que buildDateRange - "to" se trata como dia
  // inclusive (se le suma 1 dia para el limite exclusivo), no como corte a medianoche.
  const dateRange =
    from || to
      ? {
          gte: from ?? new Date(0),
          lt: to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : new Date(),
        }
      : undefined;

  const records = await findRecordsForExport({
    dateRange,
    spedizzioneFilter: listFilterForActor(actor),
    driverId,
    clientId,
    vehicleId,
    seccionWhere: seccionesToWhere(secciones),
    zonaValues: zonas,
    estadoValues: estados,
  });

  const inRange = records.filter((r) => matchesTimeRange(r, fromTime, toTime));
  await attachFuel(inRange);
  return inRange.map((record) => toResponse(record, actor));
};

export const listRecordsForActor = async (actor, dateRange) => {
  const driverId = isPrivileged(actor) ? undefined : actor.id;
  const spedizzioneFilter = listFilterForActor(actor);
  const records = await attachFuel(await findRecords({ driverId, dateRange, spedizzioneFilter }));
  return records.map((record) => toResponse(record, actor));
};

// Panel de "Pendientes" de Registros: servicios en curso de HOY (hora local Europe/
// Rome, no la del servidor) - no tiene sentido traer el historico completo (miles de
// registros con la sincronizacion de AppSheet) solo para mostrar los pocos que estan
// en curso.
export const listPendingRecordsForActor = async (actor) => {
  const driverId = isPrivileged(actor) ? undefined : actor.id;
  const [year, month, day] = new Date()
    .toLocaleDateString("en-CA", { timeZone: "Europe/Rome" })
    .split("-")
    .map(Number);
  const { gte, lt } = buildLocalDateRange(year, month, day, "Europe/Rome");
  const spedizzioneFilter = listFilterForActor(actor);
  const records = await attachFuel(await findRecordsPending({ driverId, gte, lt, spedizzioneFilter }));
  return records.map((record) => toResponse(record, actor));
};

// Para la campanita OWNER/ADMIN (ver computeAppsheetSyncAlerts en el frontend) - sin
// esto, un registro cuya escritura a AppSheet fallo quedaba en silencio hasta que
// alguien lo notara a mano comparando contra la planilla.
export const listAppsheetSyncFailuresForActor = async (actor) => {
  const spedizzioneFilter = spedizzioneFilterForActor(actor);
  const records = await findRecordsWithSyncFailure(spedizzioneFilter);
  return records.map((record) => toResponse(record, actor));
};

const SEARCH_MIN_LENGTH = 2;

// Buscador de Registros (codigo/cliente/chofer/destino). Con menos de 2 caracteres
// devuelve vacio en vez de traer resultados poco utiles.
export const searchRecordsForActor = async (actor, q) => {
  const query = (q ?? "").trim();
  if (query.length < SEARCH_MIN_LENGTH) return [];
  const driverId = isPrivileged(actor) ? undefined : actor.id;
  const spedizzioneFilter = listFilterForActor(actor);
  const records = await attachFuel(await searchRecords({ q: query, driverId, spedizzioneFilter }));
  return records.map((record) => toResponse(record, actor));
};

// Version liviana (id/fechaServicio/estado) para armar el acordeon de dias del
// mes sin traer stops/ruta/economico de cada registro. No hay datos sensibles
// aca, asi que no hace falta distinguir toFullResponse/toChoferResponse.
// Dashboard del Admin: solo OWNER/ADMIN (el chofer usa el listado normal, que ya es chico).
export const listRecordsResumenForActor = async (actor, dateRange) => {
  if (!isPrivileged(actor)) return listRecordsForActor(actor, dateRange);
  const records = await attachFuel(
    await findRecordsResumen({ dateRange, spedizzioneFilter: listFilterForActor(actor) })
  );
  return records.map(toResumenResponse);
};

export const listRecordsSummaryForActor = async (actor, dateRange) => {
  const driverId = isPrivileged(actor) ? undefined : actor.id;
  const spedizzioneFilter = listFilterForActor(actor);
  return findRecordsSummary({ driverId, dateRange, spedizzioneFilter });
};

export const getRecordByIdForActor = async (actor, id) => {
  const record = await findRecordById(id);
  if (!record) {
    throw new AppError("Registro no encontrado", 404);
  }
  assertAccess(actor, record);
  return toResponse(record, actor);
};

const HOURS_TOTAL_FIELDS = ["horasDia", "horasNoche", "tiempoEspera"];

// Cargar los totales de horas directamente (formulario viejo / app instalada sin actualizar)
// sigue funcionando, pero pasa por la misma aprobacion que el flujo nuevo:
//  - un chofer las deja PENDIENTES (o se ignoran si ya estan aprobadas);
//  - la oficina las deja APROBADAS (ella es quien aprueba).
// Solo cuenta si el valor realmente cambio: el formulario reenvia todos los campos en cada
// guardado y editar un comentario no debe aprobar horas que nadie reviso.
const applyHoursApprovalRules = (actor, record, payload) => {
  const changed = HOURS_TOTAL_FIELDS.filter((key) => key in payload && payload[key] !== record[key]);
  if (changed.length === 0) return payload;

  if (isPrivileged(actor)) {
    return {
      ...payload,
      horasEstado: "APROBADAS",
      horasRevisadasAt: new Date(),
      horasRevisadaPorId: actor.id,
    };
  }

  if (record.horasEstado === "APROBADAS") {
    return Object.fromEntries(Object.entries(payload).filter(([key]) => !HOURS_TOTAL_FIELDS.includes(key)));
  }
  return {
    ...payload,
    horasEstado: "PENDIENTE",
    horasEnviadasAt: new Date(),
    horasNota: null,
    horasDeclaradas: Object.fromEntries(
      HOURS_TOTAL_FIELDS.map((key) => [key, key in payload ? payload[key] : (record[key] ?? null)])
    ),
  };
};

// Solo las declaraciones de peajes/carburante (ver utils/faltantes.js): sin la sincronizacion con AppSheet ni el
// rematch de peajes que hace el PATCH completo, porque no cambian nada de eso.
export const updateDeclaracionesForActor = async (actor, id, data) => {
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);
  const updated = await updateRecordById(id, data);
  return toResponse(updated, actor);
};

export const updateRecordForActor = async (actor, id, data) => {
  const record = await findRecordById(id);
  if (!record) {
    throw new AppError("Registro no encontrado", 404);
  }
  assertAccess(actor, record);

  if (
    actor.cargo === "ADMIN" &&
    ("spedizzione" in data || "extrasPiazzaZona" in data) &&
    !canAccessRecordArea(actor, {
      spedizzione: "spedizzione" in data ? data.spedizzione : record.spedizzione,
      extrasPiazzaZona: "extrasPiazzaZona" in data ? data.extrasPiazzaZona : record.extrasPiazzaZona,
    })
  ) {
    throw new AppError("No tienes permisos para mover este registro fuera de tu area", 403);
  }

  let payload = data;

  if (isPrivileged(actor)) {
    if (payload.driverId) {
      await assertDriverActivo(payload.driverId);
    }

    // "salida": undefined = no se toca, null = vuelve al deposito, objeto = nueva salida.
    let salidaChange;
    if ("salida" in payload) {
      const { salida: salidaInput, ...withoutSalida } = payload;
      payload = withoutSalida;
      salidaChange = salidaInput === null ? null : await resolveSalida(salidaInput);
    }
    const currentSalida = salidaOf(record);
    const nextSalida = salidaChange === undefined ? currentSalida : (salidaChange ?? salidaOf({}));
    const salidaMoved =
      salidaChange !== undefined &&
      (nextSalida.lat !== currentSalida.lat || nextSalida.lng !== currentSalida.lng);

    if (payload.stops) {
      const { stops: direcciones, ...rest } = payload;
      if (stopsUnchanged(record.stops, direcciones)) {
        payload = rest;
      } else {
        const { stopsCreate, destinazione, rutaDistanciaKm, rutaDuracionMin, rutaGeometria, rutaCalculadaAt } =
          await buildStopsPipeline(direcciones, payload.ciudad ?? record.ciudad, nextSalida);
        payload = {
          ...rest,
          destinazione,
          rutaDistanciaKm,
          rutaDuracionMin,
          rutaGeometria,
          rutaCalculadaAt,
          stops: { deleteMany: {}, create: stopsCreate },
        };
      }
    }

    if (salidaChange !== undefined) {
      payload = { ...payload, ...salidaColumns(salidaChange) };
      // La salida cambio pero las paradas no: se recalcula la ruta con las paradas ya ubicadas.
      if (salidaMoved && !("rutaDistanciaKm" in payload)) {
        const placed = record.stops.filter((s) => s.lat != null && s.lng != null);
        if (placed.length > 0) {
          const ruta = await calculateRoute([nextSalida, ...placed]);
          payload = {
            ...payload,
            rutaDistanciaKm: ruta?.distanciaKm ?? null,
            rutaDuracionMin: ruta?.duracionMin ?? null,
            rutaGeometria: ruta?.geometria ?? null,
            rutaCalculadaAt: ruta ? new Date() : null,
          };
        }
      }
    }
  } else {
    payload = Object.fromEntries(
      Object.entries(data).filter(([key]) => SELF_EDITABLE_FIELDS.includes(key))
    );
  }

  // "choferRelevoId" no es una columna: crea, cambia o quita el segundo tramo del servicio. Va antes de
  // guardar para que un conflicto (ej. el relevo ya cargo horas) no deje el servicio a medias.
  if (isPrivileged(actor) && "choferRelevoId" in payload) {
    const { choferRelevoId, ...rest } = payload;
    payload = rest;
    await syncRelevoForRecord(record, choferRelevoId);
  }

  payload = applyHoursApprovalRules(actor, record, payload);

  let updated = await updateRecordById(id, payload);

  // Best-effort, igual que appendRecordToAppsheet/deleteRecordFromAppsheet: si falla
  // (permisos, red, cuota), el registro ya se actualizo en la app igual, no se corta
  // el flujo por esto - pero queda marcado appsheetSyncFallido=true para que la UI
  // avise. Si el registro nunca llego a tener origenExternoId porque la escritura
  // original (alta) fallo, un simple updateRecordInAppsheet no alcanza (no hace nada
  // sin origenExternoId, ver appsheetWriteback.service.js) - hay que reintentar el
  // alta completa (appendRecordToAppsheet) en vez de la edicion. Si origenExternoId
  // sigue null pero appsheetSyncFallido nunca se marco, es un registro que nunca
  // debio sincronizar (historico cargado a mano) - no se toca.
  try {
    if (updated.origenExternoId) {
      await updateRecordInAppsheet(updated);
    } else if (updated.appsheetSyncFallido) {
      await appendRecordToAppsheet(updated);
      updated = await updateRecordById(id, { origenExternoId: `${ORIGEN_PREFIX}${id}` });
    }
    if (updated.appsheetSyncFallido) {
      updated = await updateRecordById(id, { appsheetSyncFallido: false });
    }
  } catch (err) {
    console.error("No se pudo actualizar el registro en la hoja de AppSheet:", err.message);
    updated = await updateRecordById(id, { appsheetSyncFallido: true }).catch(() => updated);
  }

  // Cambiar cuando sale el servicio, su ETA, el vehiculo, el estado o las paradas (ruta) puede
  // cambiar a que servicio pertenece un peaje.
  if (RELEVANT_FOR_MATCHING.some((key) => key in payload)) {
    await rematchAssignmentsForVehicle(record.vehicleId);
    if (updated.vehicleId !== record.vehicleId) await rematchAssignmentsForVehicle(updated.vehicleId);
  }

  return toResponse(updated, actor);
};

// Ruta en vivo desde la posicion GPS actual del chofer hasta la parada final del
// servicio (no desde el deposito), a demanda: solo se llama cuando el OWNER/ADMIN
// tiene este servicio abierto/seleccionado en el mapa, no en cada refresco de posiciones
// para todos los servicios activos (eso saldria caro corriendolo cada 20s de mas).
// Best-effort: si el servicio ya no esta en camino, la ubicacion del chofer no esta
// fresca, o no hay parada geocodificada, se devuelve null y el mapa muestra "no disponible".
export const getLiveEtaForRecord = async (actor, id) => {
  const record = await findRecordById(id);
  if (!record) {
    throw new AppError("Registro no encontrado", 404);
  }
  assertAccess(actor, record);
  if (record.estado !== "IN_CONSEGNA") return null;

  // Posicion de origen: el GPS del vehiculo del servicio (o, si no tiene, el asignado al
  // chofer) - Velocity Fleet. La del celular del chofer solo si esta habilitada
  // (PHONE_LOCATION_ENABLED) y no hay del vehiculo.
  let origin = null;
  const driverUser = await findUserById(record.driverId);
  const targa = record.vehicle?.targa ?? driverUser?.vehiculoAsignado?.targa;
  const vehiclePosition = await getFreshVehiclePositionByTarga(targa);
  if (vehiclePosition) {
    origin = { lat: vehiclePosition.lat, lng: vehiclePosition.lng };
  } else if (env.PHONE_LOCATION_ENABLED) {
    const driver = await findUserLocationById(record.driverId);
    const staleSince = new Date(Date.now() - LOCATION_FRESH_MINUTES * 60 * 1000);
    if (driver?.ubicacionLat != null && driver.ubicacionLng != null && driver.ubicacionActualizada >= staleSince) {
      origin = { lat: driver.ubicacionLat, lng: driver.ubicacionLng };
    }
  }
  if (!origin) return null;

  const finalStop = record.stops[record.stops.length - 1];
  if (!finalStop || finalStop.lat == null || finalStop.lng == null) return null;

  const ruta = await calculateRoute([origin, { lat: finalStop.lat, lng: finalStop.lng }]);
  if (!ruta) return null;

  return { distanciaKm: ruta.distanciaKm, duracionMin: ruta.duracionMin, geometria: ruta.geometria };
};

export const deleteRecord = async (actor, id) => {
  const record = await findRecordById(id);
  if (!record) {
    throw new AppError("Registro no encontrado", 404);
  }
  assertAccess(actor, record);

  await purgeFilesForRecord(id);
  // Las continuaciones de un traspaso se borran con el original (cascada): sus archivos tambien.
  for (const next of record.continuaciones ?? []) await purgeFilesForRecord(next.id);
  // Los peajes asignados a este servicio vuelven a esperar uno (y se re-evaluan sin el).
  await releaseMancatosOfRecord(id);
  await releaseCombustiblesOfRecord(id);
  await deleteRecordById(id);
  await rematchAssignmentsForVehicle(record.vehicleId);

  // Best-effort, igual que la escritura al crear (ver createRecord): si falla (permisos,
  // red, cuota), el registro ya se borro de la app igual, no se corta el flujo por esto.
  try {
    await deleteRecordFromAppsheet(record);
  } catch (err) {
    console.error("No se pudo borrar el registro de la hoja de AppSheet:", err.message);
  }
};
