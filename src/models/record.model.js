import { prisma } from "../config/prisma.js";

const RECORD_INCLUDE = {
  driver: { select: { id: true, nombre: true, apellido: true } },
  vehicle: { select: { id: true, targa: true, modelo: true } },
  client: { select: { id: true, nombre: true } },
  stops: { orderBy: { orden: "asc" } },
  // Comprobantes de combustible asignados a este servicio (ver utils/fuelCost.js).
  combustibles: {
    orderBy: { fechaHora: "asc" },
    select: { id: true, monto: true, fechaHora: true, metodo: true, asignacion: true },
  },
  // Peajes (mancato pagamento) que el sistema asigno a este servicio.
  mancatos: {
    orderBy: { fechaHoraTransito: "asc" },
    select: {
      id: true,
      numero: true,
      fechaHoraTransito: true,
      tramo: true,
      asignacion: true,
      costo: true,
      pagado: true,
    },
  },
};

const RECORD_RELATIONS_SELECT = {
  driver: { select: { id: true, nombre: true, apellido: true } },
  vehicle: { select: { id: true, targa: true, modelo: true } },
  client: { select: { id: true, nombre: true } },
};

// Lista liviana para findMany: sin "stops" (lat/lng de cada parada) ni
// "rutaGeometria" (el poligono de la ruta, ~10-20KB por registro en promedio).
// Ambos solo hacen falta cuando se abre UN servicio puntual (detalle o mapa con
// ese servicio seleccionado -ver getRecordRequest en el frontend-), no en cada
// listado/polling de todos los registros (dashboard, notificaciones, mapa cada
// 20s). Sin esto, ese poligono viaja completo desde Neon en cada uno de esos
// pedidos aunque nadie lo este mirando - la diferencia es de KBs a MBs por pedido.
const RECORD_SELECT_LIST = {
  id: true,
  estado: true,
  driverId: true,
  vehicleId: true,
  clientId: true,
  ...RECORD_RELATIONS_SELECT,
  fechaServicio: true,
  eta: true,
  fechaRetiro: true,
  descripcion: true,
  codigo: true,
  destinazione: true,
  ciudad: true,
  aplicativo: true,
  spedizzione: true,
  extrasPiazzaZona: true,
  origenExternoId: true,
  appsheetSyncFallido: true,
  rutaDistanciaKm: true,
  rutaDuracionMin: true,
  rutaCalculadaAt: true,
  horasDia: true,
  horasNoche: true,
  tiempoEspera: true,
  comentarios: true,
  kilometrosReales: true,
  kilometros: true,
  precioKm: true,
  areaC: true,
  costoEspera: true,
  costoTraforoFrejusBrennero: true,
  peajes: true,
  vignetta: true,
  costoHotel: true,
  costoOtros: true,
  pagoRecibido: true,
  costoCombustible: true,
  clienteConfirmado: true,
  createdAt: true,
  updatedAt: true,
};

export const createRecord = (data) =>
  prisma.record.create({ data, include: RECORD_INCLUDE });

export const findRecordById = (id) =>
  prisma.record.findUnique({ where: { id }, include: RECORD_INCLUDE });

// Usado por el sync de AppSheet para saber si una fila de la planilla ya se importo
// (origenExternoId es unico) antes de volver a crearla.
export const findRecordByOrigenExternoId = (origenExternoId) =>
  prisma.record.findUnique({ where: { origenExternoId }, select: { id: true } });

// Todos los codigos ya usados - el sync de AppSheet lo usa para saber si el CODIGO de
// una fila (columna CÓDIGO de la planilla) ya esta tomado por OTRO registro distinto
// antes de intentar crear con ese mismo valor (el codigo en AppSheet no es realmente
// unico: se reutiliza el mismo texto en envios distintos, a diferencia de la columna
// ID que si es unica por fila).
export const findAllCodigos = async () => {
  const records = await prisma.record.findMany({ select: { codigo: true } });
  return new Set(records.map((r) => r.codigo));
};

// Firma liviana (chofer + fecha + km) de los registros con fecha desde "since" -
// el sync de AppSheet la usa para no duplicar registros que ya se cargaron a mano
// (import de CSV) antes de que existiera el origenExternoId. Solo mira registros SIN
// origenExternoId: los que ya vienen de un sync anterior se distinguen por su propio
// origenExternoId (chequeo aparte, ver findRecordByOrigenExternoId), no por esta firma
// - si se los incluyera aca, un chofer con 2 viajes reales distintos el mismo dia y el
// mismo KM (ej. 2 vueltas de "naveta" a 25km) haria que el segundo se descarte como si
// fuera un duplicado del primero.
export const findRecordDedupSignatures = async (since) => {
  const records = await prisma.record.findMany({
    where: { fechaServicio: { gte: since }, origenExternoId: null },
    select: { driverId: true, fechaServicio: true, kilometros: true },
  });
  return records.map((r) => ({
    driverId: r.driverId,
    dateKey: r.fechaServicio.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" }),
    kilometros: r.kilometros,
  }));
};

// filters: { driverId?: string, dateRange?: { gte: Date, lt: Date }, spedizzioneFilter?: object }
export const findRecords = ({ driverId, dateRange, spedizzioneFilter } = {}) =>
  prisma.record.findMany({
    where: {
      ...(driverId ? { driverId } : {}),
      ...(dateRange ? { fechaServicio: { gte: dateRange.gte, lt: dateRange.lt } } : {}),
      ...(spedizzioneFilter ?? {}),
    },
    select: RECORD_SELECT_LIST,
    orderBy: { fechaServicio: "desc" },
  });

// Export CSV de Registros (ver record.service.js): mismos filtros de dateRange/
// spedizzioneFilter (scoping del actor) que findRecords, mas driverId/clientId/
// vehicleId/seccionWhere/zonaValues/estadoValues puntuales que el usuario elige en el
// modal de export. seccionWhere ya viene armado por el service (igual que
// spedizzioneFilter/AREA_SPEDIZZIONE_WHERE) para poder representar "Extras Piazza"
// como spedizzione IN ('EXTRA_PIAZZA') OR NULL sin depender de que Prisma soporte
// null dentro de un "in". El filtro de hora del dia (fromTime/toTime) NO se resuelve
// aca - se aplica despues en JS sobre este resultado (ver exportRecordsForActor).
export const findRecordsForExport = ({
  dateRange,
  spedizzioneFilter,
  driverId,
  clientId,
  vehicleId,
  seccionWhere,
  zonaValues,
  estadoValues,
} = {}) =>
  prisma.record.findMany({
    where: {
      ...(dateRange ? { fechaServicio: { gte: dateRange.gte, lt: dateRange.lt } } : {}),
      ...(spedizzioneFilter ?? {}),
      ...(driverId ? { driverId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(vehicleId ? { vehicleId } : {}),
      ...(seccionWhere ?? {}),
      ...(zonaValues?.length ? { extrasPiazzaZona: { in: zonaValues } } : {}),
      ...(estadoValues?.length ? { estado: { in: estadoValues } } : {}),
    },
    select: RECORD_SELECT_LIST,
    orderBy: { fechaServicio: "asc" },
  });

// Registros cuyo ultimo intento de sincronizar con AppSheet fallo (ver
// appsheetSyncFallido en record.service.js) - siempre son pocos, no hace falta acotar
// por fecha como el resto de los listados.
export const findRecordsWithSyncFailure = (spedizzioneFilter) =>
  prisma.record.findMany({
    where: { appsheetSyncFallido: true, ...(spedizzioneFilter ?? {}) },
    select: RECORD_SELECT_LIST,
    orderBy: { updatedAt: "desc" },
  });

// Busqueda liviana por codigo/cliente/chofer/destino, con limite - pensada para tipear
// mientras se busca, no para traer todo el historico y filtrar en el navegador.
const SEARCH_RESULTS_LIMIT = 50;

export const searchRecords = ({ q, driverId, spedizzioneFilter }) =>
  prisma.record.findMany({
    where: {
      ...(driverId ? { driverId } : {}),
      // spedizzioneFilter (EXTRAS_PIAZZA) trae su propia clave OR - en AND aparte para
      // no pisar el OR de los campos de busqueda de abajo.
      AND: [
        spedizzioneFilter ?? {},
        {
          OR: [
            { codigo: { contains: q, mode: "insensitive" } },
            { destinazione: { contains: q, mode: "insensitive" } },
            { client: { nombre: { contains: q, mode: "insensitive" } } },
            { driver: { nombre: { contains: q, mode: "insensitive" } } },
            { driver: { apellido: { contains: q, mode: "insensitive" } } },
          ],
        },
      ],
    },
    select: RECORD_SELECT_LIST,
    orderBy: { fechaServicio: "desc" },
    take: SEARCH_RESULTS_LIMIT,
  });

// Pendientes (IN_SOSPESO/IN_CONSEGNA/RITIRATO) acotado a una ventana de fechaServicio
// (panel de "Pendientes" de Registros) - no tiene sentido traer TODOS los registros
// historicos (miles ya, con la sincronizacion de AppSheet) solo para filtrar los
// pocos que estan en curso ahora mismo.
const EN_PROCESO_ESTADOS = ["IN_SOSPESO", "IN_CONSEGNA", "RITIRATO"];

export const findRecordsPending = ({ driverId, gte, lt, spedizzioneFilter } = {}) =>
  prisma.record.findMany({
    where: {
      estado: { in: EN_PROCESO_ESTADOS },
      fechaServicio: { gte, lt },
      ...(driverId ? { driverId } : {}),
      ...(spedizzioneFilter ?? {}),
    },
    select: RECORD_SELECT_LIST,
    orderBy: { eta: "asc" },
  });

// Version liviana de findRecords: solo lo necesario para armar un acordeon de dias
// (conteos), sin stops/ruta/economico. El agrupado por dia calendario se hace en el
// frontend (misma logica que ya usa para la vista completa), asi no hay riesgo de
// que el "dia" del backend no coincida con el "dia" que ve el usuario en su huso horario.
export const findRecordsSummary = ({ driverId, dateRange, spedizzioneFilter } = {}) =>
  prisma.record.findMany({
    where: {
      ...(driverId ? { driverId } : {}),
      ...(dateRange ? { fechaServicio: { gte: dateRange.gte, lt: dateRange.lt } } : {}),
      ...(spedizzioneFilter ?? {}),
    },
    select: {
      id: true,
      fechaServicio: true,
      estado: true,
      spedizzione: true,
      extrasPiazzaZona: true,
      kilometros: true,
      kilometrosReales: true,
    },
    orderBy: { fechaServicio: "desc" },
  });

export const updateRecordById = (id, data) =>
  prisma.record.update({ where: { id }, data, include: RECORD_INCLUDE });

// Usado por el mapa de ubicaciones: solo se muestra un chofer si tiene un
// servicio en camino ahora mismo. "ultimaParada" (la parada final) se usa para
// calcular la ruta en vivo desde la posicion actual del chofer.
export const findActiveRecordsByDriverIds = (driverIds) =>
  prisma.record.findMany({
    where: { estado: "IN_CONSEGNA", driverId: { in: driverIds } },
    select: {
      id: true,
      driverId: true,
      codigo: true,
      destinazione: true,
      stops: {
        orderBy: { orden: "desc" },
        take: 1,
        select: { lat: true, lng: true },
      },
    },
  });

export const deleteRecordById = (id) => prisma.record.delete({ where: { id } });

// Si se borra un servicio, los peaje que tenia asignados vuelven a esperar uno nuevo.
export const releaseMancatosOfRecord = (recordId) =>
  prisma.mancatoPagamento.updateMany({
    where: { recordId },
    data: {
      recordId: null,
      asignacion: "EN_ESPERA",
      tramo: null,
      asignacionMotivo: "El servicio asignado se elimino.",
    },
  });

// Igual para las cargas de combustible: vuelven a esperar un servicio.
export const releaseCombustiblesOfRecord = (recordId) =>
  prisma.registroCombustible.updateMany({
    where: { recordId },
    data: { recordId: null, asignacion: "EN_ESPERA", asignacionMotivo: "El servicio asignado se elimino." },
  });
