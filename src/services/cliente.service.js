import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { cachedResponse } from "../utils/responseCache.js";
import { romeDay } from "../utils/romeTime.js";
import { getSeguimiento, RETRASO_AVISO_MIN } from "./seguimiento.service.js";
import { getSignedUrlForKey } from "./storage.service.js";

// Lo que ve un usuario CLIENTE: solo lectura y SIEMPRE los servicios de su propia empresa (User.clienteId).
//  - Del chofer solo se ve la targa del vehiculo: nunca su nombre ni su telefono.
//  - No se devuelve la ruta del viaje ni las paradas de otros clientes: una furgoneta lleva paquetes de varios clientes.
//  - La posicion de la furgoneta se muestra solo mientras el servicio de ese cliente esta en camino; en cuanto llega o se
//    entrega deja de verse, para no seguirla durante el reparto de los demas.
// Cada ruta exige ademas el modulo correspondiente (User.clienteModulos, ver constants/clientes.js).

const DAY_MS = 24 * 60 * 60 * 1000;
const SEGUIMIENTO_TTL_MS = 25 * 1000;
const FOTO_TIPOS = ["BOLLA", "FOTO_ENTREGA"];

export const requireModulo = (user, ...modulos) => {
  if (!user.clienteId) throw new AppError("Tu usuario no tiene una empresa cliente asignada", 403);
  if (!modulos.some((m) => user.clienteModulos?.includes(m))) throw new AppError("No tienes acceso a esta seccion", 403);
};

export const getClienteMe = (user) => ({
  usuario: { id: user.id, nombre: user.nombre, apellido: user.apellido },
  cliente: user.cliente ? { id: user.cliente.id, nombre: user.cliente.nombre } : null,
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
  const enCamino = servicios.filter((s) => s.clienteId === user.clienteId).map((s) => toClienteServicio(s, { conMapa }));

  const now = Date.now();
  const programados = await prisma.record.findMany({
    where: {
      clientId: user.clienteId,
      estado: "IN_SOSPESO",
      eta: { gte: new Date(now - 3 * 60 * 60 * 1000), lte: new Date(now + DAY_MS) },
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
    where: { clientId: user.clienteId, fechaServicio: { gte: from, lt: to } },
    select: {
      id: true,
      codigo: true,
      estado: true,
      fechaServicio: true,
      eta: true,
      llegadaGpsAt: true,
      destinazione: true,
      vehicle: { select: { targa: true } },
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
    where: { id: recordId, clientId: user.clienteId },
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
