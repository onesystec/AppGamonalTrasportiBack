import { prisma } from "../config/prisma.js";
import { SOLICITUD_SERVICIOS } from "../constants/solicitudes.js";
import { AppError } from "../utils/AppError.js";
import { actorAreaKeys } from "../utils/areaAccess.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Registros limitados de un usuario CLIENTE (Piazza Spedizioni) y su paso a servicio real.
//  - El cliente carga la solicitud con pocos datos (cliente, destinazione, fecha y hora, km, pagado, varie) y ve su estado.
//  - La oficina (Admin y Responsables de esa area) la ve como solicitud pendiente, completa el formulario del servicio y, al crearlo,
//    la solicitud queda ACEPTADA y enlazada al servicio (linkSolicitudToRecord). Tambien puede rechazarla con un motivo.
//  - Del servicio real el cliente no ve nada: solo el estado de su solicitud.

const PERSON = { select: { id: true, nombre: true, apellido: true } };

const personName = (p) => (p ? `${p.nombre} ${p.apellido}`.trim() : null);

const toDto = (s, { office = false } = {}) => ({
  id: s.id,
  servicio: s.servicio,
  servicioLabel: SOLICITUD_SERVICIOS[s.servicio]?.label ?? s.servicio,
  cliente: s.cliente,
  destinazione: s.destinazione,
  fechaHora: s.fechaHora,
  km: s.km,
  pagato: s.pagato,
  varie: s.varie,
  varie2: s.varie2,
  aplicativo: s.aplicativo,
  estado: s.estado,
  motivoRechazo: s.motivoRechazo,
  createdAt: s.createdAt,
  ...(office ? { creadoPor: personName(s.creadoPor), empresa: s.empresa?.nombre ?? null, recordId: s.recordId } : {}),
});

// --- Usuario cliente ---

export const requireRegistro = (user) => {
  if (!user.clienteModulos?.includes("REGISTRO")) throw new AppError("No tienes acceso a esta seccion", 403);
};

// Las solicitudes propias y las de su empresa (otros usuarios de la misma empresa cliente).
const scopeWhere = (user) => ({ OR: [{ creadoPorId: user.id }, ...(user.clienteId ? [{ empresaId: user.clienteId }] : [])] });

const findOwned = async (user, id) => {
  const solicitud = await prisma.solicitudServicio.findFirst({ where: { id, ...scopeWhere(user) } });
  if (!solicitud) throw new AppError("Solicitud no encontrada", 404);
  return solicitud;
};

const HISTORY_DAYS = 60;

export const listSolicitudesCliente = async (user) => {
  requireRegistro(user);
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.solicitudServicio.findMany({
    where: { AND: [scopeWhere(user), { OR: [{ estado: "PENDIENTE" }, { fechaHora: { gte: since } }] }] },
    orderBy: { fechaHora: "desc" },
    take: 300,
  });
  return rows.map((s) => toDto(s));
};

const ownerAndResponsableIds = async (servicio) => {
  const areaKeys = SOLICITUD_SERVICIOS[servicio]?.areaKeys ?? [];
  const users = await prisma.user.findMany({
    where: { estado: "ACTIVO", OR: [{ cargo: "OWNER" }, { cargo: "ADMIN", areasPermitidas: { hasSome: areaKeys } }] },
    select: { id: true },
  });
  return users.map((u) => u.id);
};

const notifyOffice = async (solicitud, user) => {
  try {
    const ids = await ownerAndResponsableIds(solicitud.servicio);
    await sendPushToUserIds(ids, {
      title: "Nueva solicitud de servicio",
      body: `${user.cliente?.nombre ?? `${user.nombre} ${user.apellido}`}: ${solicitud.cliente} - ${solicitud.destinazione}`,
      data: { type: "solicitud", solicitudId: solicitud.id },
    });
  } catch {
    // Best-effort: un fallo de push no debe romper la solicitud.
  }
};

export const createSolicitudCliente = async (user, data) => {
  requireRegistro(user);
  const solicitud = await prisma.solicitudServicio.create({ data: { ...data, creadoPorId: user.id, empresaId: user.clienteId ?? null } });
  void notifyOffice(solicitud, user);
  return toDto(solicitud);
};

export const updateSolicitudCliente = async (user, id, data) => {
  requireRegistro(user);
  const current = await findOwned(user, id);
  if (current.estado !== "PENDIENTE") throw new AppError("Solo se pueden editar solicitudes pendientes", 409);
  const solicitud = await prisma.solicitudServicio.update({ where: { id }, data });
  return toDto(solicitud);
};

export const deleteSolicitudCliente = async (user, id) => {
  requireRegistro(user);
  const current = await findOwned(user, id);
  if (current.estado === "ACEPTADA") throw new AppError("La solicitud ya fue aceptada y no se puede borrar", 409);
  await prisma.solicitudServicio.delete({ where: { id } });
};

// --- Oficina (Admin y Responsables) ---

// Un Responsable solo ve las solicitudes de sus areas; el Admin ve todas.
const officeWhere = (actor) => {
  const keys = actorAreaKeys(actor);
  if (keys === null) return {};
  const tipos = Object.entries(SOLICITUD_SERVICIOS)
    .filter(([, def]) => def.areaKeys.some((k) => keys.includes(k)))
    .map(([tipo]) => tipo);
  return { servicio: { in: tipos } };
};

const OFFICE_INCLUDE = { creadoPor: PERSON, empresa: { select: { nombre: true } } };

export const listSolicitudesForActor = async (actor, { estado = "PENDIENTE" } = {}) => {
  const rows = await prisma.solicitudServicio.findMany({
    where: { ...officeWhere(actor), ...(estado === "TODAS" ? {} : { estado }) },
    include: OFFICE_INCLUDE,
    orderBy: estado === "PENDIENTE" ? { fechaHora: "asc" } : { updatedAt: "desc" },
    take: estado === "PENDIENTE" ? 300 : 100,
  });
  return rows.map((s) => toDto(s, { office: true }));
};

const findForActor = async (actor, id) => {
  const solicitud = await prisma.solicitudServicio.findFirst({ where: { id, ...officeWhere(actor) }, include: OFFICE_INCLUDE });
  if (!solicitud) throw new AppError("Solicitud no encontrada", 404);
  return solicitud;
};

const notifyCreator = (solicitud, title, body) =>
  sendPushToUserIds([solicitud.creadoPorId], { title, body, data: { type: "solicitud", solicitudId: solicitud.id } }).catch(() => {});

export const rechazarSolicitudForActor = async (actor, id, { motivo }) => {
  const current = await findForActor(actor, id);
  if (current.estado !== "PENDIENTE") throw new AppError("La solicitud ya fue revisada", 409);
  const solicitud = await prisma.solicitudServicio.update({
    where: { id },
    data: { estado: "RECHAZADA", motivoRechazo: motivo ?? null, revisadoPorId: actor.id, revisadoAt: new Date() },
    include: OFFICE_INCLUDE,
  });
  void notifyCreator(solicitud, "Solicitud rechazada", `${solicitud.cliente} - ${solicitud.destinazione}${motivo ? `: ${motivo}` : ""}`);
  return toDto(solicitud, { office: true });
};

// Al crear el servicio real desde una solicitud: queda aceptada y enlazada. No rompe la creacion del servicio si la solicitud ya no esta
// pendiente (la borraron, otro la rechazo...): en ese caso no hace nada y devuelve false.
export const linkSolicitudToRecord = async (actor, solicitudId, recordId) => {
  try {
    const current = await findForActor(actor, solicitudId);
    if (current.estado !== "PENDIENTE") return false;
    const { count } = await prisma.solicitudServicio.updateMany({
      where: { id: solicitudId, estado: "PENDIENTE" },
      data: { estado: "ACEPTADA", recordId, revisadoPorId: actor.id, revisadoAt: new Date(), motivoRechazo: null },
    });
    if (count) void notifyCreator(current, "Solicitud aceptada", `${current.cliente} - ${current.destinazione} ya esta en el registro`);
    return count > 0;
  } catch (err) {
    console.error("No se pudo enlazar la solicitud con el servicio:", err.message);
    return false;
  }
};
