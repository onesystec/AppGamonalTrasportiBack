import { prisma } from "../config/prisma.js";
import { CLIENTE_RETRASO_MAX_MIN } from "../constants/clientes.js";
import { AppError } from "../utils/AppError.js";
import { recordAreaWhere } from "../utils/areaAccess.js";
import { cachedResponse } from "../utils/responseCache.js";
import { romeDay } from "../utils/romeTime.js";
import { calculateRoute } from "./routing.service.js";
import { getSeguimiento, RETRASO_AVISO_MIN } from "./seguimiento.service.js";
import { getSignedUrlForKey } from "./storage.service.js";
import { listVehicleLivePositionsForActor } from "./vehicle.service.js";
import { getDisponibilidadForActor } from "./disponibilidad.service.js";

// Lo que ve un usuario CLIENTE: solo lectura y SIEMPRE los servicios de su alcance: los de su empresa (User.clienteId) y/o los de las
// spedizioni (areas de servicio) que el Admin le marco (User.clienteAreas). Ve todos los servicios de ese alcance, no uno solo.
//  - Del chofer solo se ve la targa del vehiculo: nunca su telefono. Su nombre y el Milano/Roma asignado (aplicativo) se ven solo en el historial
//    de servicios (el seguimiento, el mapa y la disponibilidad siguen sin nombres).
//  - No se devuelve la ruta del viaje ni las paradas de otros clientes: una furgoneta lleva paquetes de varios clientes.
//  - La posicion de la furgoneta se muestra solo mientras el servicio de ese cliente esta en camino; en cuanto llega o se
//    entrega deja de verse, para no seguirla durante el reparto de los demas.
// Cada ruta exige ademas el modulo correspondiente (User.clienteModulos, ver constants/clientes.js).

const DAY_MS = 24 * 60 * 60 * 1000;
const SEGUIMIENTO_TTL_MS = 25 * 1000;
const FOTO_TIPOS = ["BOLLA", "FOTO_ENTREGA"];

export const requireModulo = (user, ...modulos) => {
  if (!user.clienteId && !user.clienteAreas?.length) throw new AppError("Tu usuario no tiene empresa ni spedizioni asignadas", 403);
  if (!modulos.some((m) => user.clienteModulos?.includes(m))) throw new AppError("No tienes acceso a esta seccion", 403);
};

// Filtro de servicios (Record) del alcance del cliente: su empresa y/o sus spedizioni.
export const clienteScopeWhere = (user) => {
  const conds = [];
  if (user.clienteId) conds.push({ clientId: user.clienteId });
  if (user.clienteAreas?.length) conds.push(recordAreaWhere({ cargo: "ADMIN", areasPermitidas: user.clienteAreas }));
  return conds.length === 1 ? conds[0] : { OR: conds };
};

// Un servicio del seguimiento (con clienteId y tipo = su spedizione) esta dentro del alcance del cliente.
// Servicios de seguimiento que se le muestran al cliente: se dejan fuera los que llevan mas de 12 h de retraso (probablemente olvidados).
export const esVisibleParaCliente = (s) => (s.retrasoMin ?? 0) <= CLIENTE_RETRASO_MAX_MIN;

const enAlcance = (user, s) => (user.clienteId && s.clienteId === user.clienteId) || Boolean(user.clienteAreas?.includes(s.tipo));

export const getClienteMe = (user) => ({
  usuario: { id: user.id, nombre: user.nombre, apellido: user.apellido },
  cliente: user.cliente ? { id: user.cliente.id, nombre: user.cliente.nombre } : null,
  spedizioni: user.clienteAreas ?? [],
  modulos: user.clienteModulos ?? [],
});

const ESTADO_LABEL = {
  IN_SOSPESO: "Programado",
  IN_CONSEGNA: "En camino",
  RITIRATO: "En camino",
  CONSEGNATO: "Entregado",
  RISCHEDULATO: "Reprogramado",
  ANNULLATO: "Anulado",
};

// Una sola lectura de todos los viajes en camino para todos los clientes que miran a la vez (el calculo de GPS es pesado).
const allSeguimiento = () =>
  cachedResponse("cliente-seguimiento", SEGUIMIENTO_TTL_MS, () => getSeguimiento({ cargo: "OWNER" }), { small: true });

// Mapa "En Vivo": la posicion de los vehiculos visibles en el Mapa de la oficina (los mismos que ve el Admin), solo con lo que hace falta para
// dibujarlos: targa, posicion, movimiento y hora. Sin chofer, servicio ni cliente: una furgoneta lleva paquetes de varios clientes. Una sola
// lectura compartida entre todos los que miran a la vez (cada una consulta al GPS).
const EN_VIVO_TTL_MS = 20 * 1000;

export const getEnVivoCliente = async (user) => {
  requireModulo(user, "EN_VIVO");
  const positions = await cachedResponse("cliente-en-vivo", EN_VIVO_TTL_MS, () => listVehicleLivePositionsForActor(), { small: true });
  return {
    generadoAt: new Date().toISOString(),
    vehiculos: positions.map((p) => ({
      targa: p.targa,
      lat: p.lat,
      lng: p.lng,
      speed: p.speed ?? null,
      speedUnit: p.speedUnit ?? null,
      ignition: p.ignition ?? null,
      direction: p.direction ?? null,
      updatedAt: p.updatedAt ?? null,
    })),
  };
};

// Disponibilitá: que vehiculos y que choferes estan libres cada dia, SIN motivos: del chofer se ve el nombre y los dias en que no esta disponible, pero no
// por que (ni si esta enfermo, de vacaciones, de permiso o con un servicio); del vehiculo, la targa y los dias en que no esta disponible (por un servicio, de
// cualquier cliente, o por mantenimiento). Los mismos vehiculos que ve el cliente en el mapa En Vivo. Una lectura compartida por rango de fechas (cada una
// consulta la base).
const DISPONIBILIDAD_TTL_MS = 60 * 1000;

export const getDisponibilidadCliente = async (user, { desde, hasta } = {}) => {
  requireModulo(user, "DISPONIBILIDAD");
  const full = await cachedResponse(
    `cliente-disponibilidad:${desde ?? ""}:${hasta ?? ""}`,
    DISPONIBILIDAD_TTL_MS,
    () => getDisponibilidadForActor({ cargo: "OWNER" }, { desde, hasta }),
    { small: true }
  );
  // Un permiso todavia en revision no saca al chofer de la lista de libres (igual que en la oficina).
  const libres = Object.fromEntries(
    full.dias.map((day) => [day, full.choferes.filter((c) => (c.dias[day] ?? []).every((i) => i.pendiente)).length])
  );
  return {
    desde: full.desde,
    hasta: full.hasta,
    hoy: full.hoy,
    dias: full.dias,
    vehiculos: full.vehiculos
      .filter((v) => v.visible)
      .map((v) => ({ targa: v.nombre, ocupados: full.dias.filter((day) => (v.dias[day] ?? []).length > 0) })),
    choferes: {
      total: full.choferes.length,
      libres,
      // Un permiso todavia en revision no cuenta como no disponible (igual que arriba).
      lista: full.choferes.map((c) => ({ nombre: c.nombre, ocupados: full.dias.filter((day) => (c.dias[day] ?? []).some((i) => !i.pendiente)) })),
    },
  };
};

export const toClienteServicio = (s, { conMapa }) => {
  const llego = Boolean(s.llego);
  const retrasoMin = Math.max(0, s.retrasoMin ?? 0);
  const conPosicion = conMapa && !llego && s.gps && s.gps.fuente !== "SIMULADO";
  return {
    id: s.id,
    codigo: s.codigo,
    targa: s.vehiculo ?? null,
    destino: s.destino,
    destinoCoords: conMapa ? s.destinoCoords ?? null : null,
    etaPlan: s.etaPlan,
    llegadaEstimada: llego ? null : s.llegadaEstimada,
    minutosRestantes: llego ? null : s.minutosRestantes,
    retrasoMin,
    estado: llego ? "LLEGO" : retrasoMin >= RETRASO_AVISO_MIN ? "CON_RETRASO" : "EN_CAMINO",
    llegoAt: llego ? s.llegoAt : null,
    posicion: conPosicion
      ? { lat: s.gps.lat, lng: s.gps.lng, rumbo: s.gps.rumbo ?? null, actualizada: s.gps.actualizada }
      : null,
    sinSenal: !llego && !conPosicion && Boolean(s.sinGps),
  };
};

// Servicios en camino de la empresa del usuario (con su posicion si tiene el mapa) y los que estan programados para hoy.
export const getSeguimientoCliente = async (user) => {
  requireModulo(user, "MAPA", "LISTA");
  const conMapa = user.clienteModulos.includes("MAPA");
  const { servicios, generadoAt } = await allSeguimiento();
  const enCamino = servicios.filter((s) => enAlcance(user, s) && esVisibleParaCliente(s)).map((s) => toClienteServicio(s, { conMapa }));

  const now = Date.now();
  const programados = await prisma.record.findMany({
    where: {
      AND: [clienteScopeWhere(user), { estado: "IN_SOSPESO", eta: { gte: new Date(now - 3 * 60 * 60 * 1000), lte: new Date(now + DAY_MS) } }],
    },
    select: { id: true, codigo: true, eta: true, destinazione: true, vehicle: { select: { targa: true } } },
    orderBy: { eta: "asc" },
    take: 50,
  });

  return {
    generadoAt,
    enCamino,
    programados: programados.map((r) => ({ id: r.id, codigo: r.codigo, targa: r.vehicle?.targa ?? null, destino: r.destinazione, etaPlan: r.eta.toISOString() })),
  };
};

const monthOrCurrent = (month) => month ?? romeDay().slice(0, 7);

// Servicios del mes de la empresa: el historial y la base del Excel.
export const listServiciosCliente = async (user, { month } = {}) => {
  const m = monthOrCurrent(month);
  const first = new Date(`${m}-01T00:00:00.000Z`);
  const from = new Date(first.getTime() - DAY_MS);
  const to = new Date(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)).getTime() + DAY_MS);
  const rows = await prisma.record.findMany({
    where: { AND: [clienteScopeWhere(user), { fechaServicio: { gte: from, lt: to } }] },
    select: {
      id: true,
      codigo: true,
      estado: true,
      fechaServicio: true,
      eta: true,
      llegadaGpsAt: true,
      destinazione: true,
      aplicativo: true,
      vehicle: { select: { targa: true } },
      driver: { select: { nombre: true, apellido: true } },
      stops: { orderBy: { orden: "asc" }, select: { direccion: true } },
      files: { where: { tipoArchivo: { in: FOTO_TIPOS } }, select: { id: true } },
    },
    orderBy: { fechaServicio: "desc" },
    take: 1500,
  });
  const verFotos = user.clienteModulos.includes("FOTOS");
  return {
    month: m,
    servicios: rows
      .filter((r) => romeDay(r.fechaServicio).startsWith(m))
      .map((r) => ({
        id: r.id,
        codigo: r.codigo,
        fecha: r.fechaServicio.toISOString(),
        estado: r.estado,
        estadoLabel: ESTADO_LABEL[r.estado] ?? r.estado,
        targa: r.vehicle?.targa ?? null,
        chofer: r.driver ? `${r.driver.nombre} ${r.driver.apellido}`.trim() : null,
        aplicativo: r.aplicativo ?? null,
        destino: r.stops.at(-1)?.direccion ?? r.destinazione,
        etaPlan: r.eta.toISOString(),
        llegoAt: r.llegadaGpsAt ? r.llegadaGpsAt.toISOString() : null,
        puntualidadMin: r.llegadaGpsAt ? Math.round((r.llegadaGpsAt.getTime() - r.eta.getTime()) / 60000) : null,
        fotos: verFotos ? r.files.length : 0,
      })),
  };
};

// Fotos de entrega y bolla de un servicio de la empresa (URL firmada, valida un rato).
export const getFotosCliente = async (user, recordId) => {
  const record = await prisma.record.findFirst({
    where: { AND: [{ id: recordId }, clienteScopeWhere(user)] },
    select: { id: true, files: { where: { tipoArchivo: { in: FOTO_TIPOS } }, orderBy: { createdAt: "asc" }, select: { id: true, archivoKey: true, tipoArchivo: true } } },
  });
  if (!record) throw new AppError("Servicio no encontrado", 404);
  const fotos = await Promise.all(
    record.files.map(async (f) => ({
      id: f.id,
      tipo: f.tipoArchivo === "BOLLA" ? "Bolla" : "Foto de entrega",
      url: await getSignedUrlForKey(f.archivoKey),
      esPdf: f.archivoKey.toLowerCase().endsWith(".pdf"),
    }))
  );
  return { fotos };
};

const RUTA_TTL_MS = 30 * 1000;

// Recorrido que le falta a la furgoneta hasta la parada de ESTE cliente, para dibujarlo en el mapa al elegir un servicio. Es la ruta por
// carretera entre la posicion actual y su parada, y nada mas: no pasa por las paradas de otros clientes ni sale de la ruta del viaje.
// Si el servidor de rutas no responde, se devuelve una linea recta (aproximada: true) para que igual se vea hacia donde va.
// Se calcula una vez cada 30 segundos y por posicion (el servidor publico de rutas no debe recibir una consulta por cada cliente que mira).
export const getRutaCliente = async (user, id) => {
  requireModulo(user, "MAPA");
  const { servicios } = await allSeguimiento();
  const s = servicios.find((x) => x.id === id && enAlcance(user, x) && esVisibleParaCliente(x));
  if (!s) throw new AppError("Servicio no encontrado", 404);
  return rutaParaServicio(s);
};

// s: un servicio del seguimiento (con su gps y las coordenadas de su parada final).
export const rutaParaServicio = async (s) => {
  if (s.llego || !s.gps || s.gps.fuente === "SIMULADO" || !s.destinoCoords) return { ruta: null };

  const origen = { lat: s.gps.lat, lng: s.gps.lng };
  const destino = s.destinoCoords;
  const key = `cliente-ruta:${s.id}:${origen.lat.toFixed(3)},${origen.lng.toFixed(3)}`;
  return cachedResponse(
    key,
    RUTA_TTL_MS,
    async () => {
      const route = await calculateRoute([origen, destino]);
      if (route?.geometria?.coordinates?.length) {
        return { ruta: { geometria: route.geometria, distanciaKm: Math.round(route.distanciaKm * 10) / 10, aproximada: false } };
      }
      const km = Math.round(distanciaRectaKm(origen, destino) * 10) / 10;
      return {
        ruta: {
          geometria: { type: "LineString", coordinates: [[origen.lng, origen.lat], [destino.lng, destino.lat]] },
          distanciaKm: km,
          aproximada: true,
        },
      };
    },
    { small: true }
  );
};

// Distancia en linea recta (haversine) en km: solo para la ruta aproximada de respaldo.
const distanciaRectaKm = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
