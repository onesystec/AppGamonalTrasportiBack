import { prisma } from "../config/prisma.js";
import { areaKeysDeSolicitud, SOLICITUD_SERVICIOS } from "../constants/solicitudes.js";
import { AppError } from "../utils/AppError.js";
import { actorAreaKeys } from "../utils/areaAccess.js";
import { romeLocalToDate } from "../utils/romeTime.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { getSignedUrlForKey } from "./storage.service.js";
import { geocodeAddress, geocodePreview } from "./geocoding.service.js";
import { calculateRoute } from "./routing.service.js";
import { parseServicioTexto } from "./servicioTexto.service.js";

// Registros limitados de un usuario CLIENTE (Piazza Spedizioni) y su paso a servicio real.
//  - El cliente carga la solicitud con pocos datos (cliente, destinazione, fecha y hora, km, pagado, varie) y ve su estado.
//  - La oficina (Admin y Responsables de esa area) la ve como solicitud pendiente, completa el formulario del servicio y, al crearlo,
//    la solicitud queda ACEPTADA y enlazada al servicio (linkSolicitudToRecord). Tambien puede rechazarla con un motivo.
//  - Del servicio real el cliente no ve nada: solo el estado de su solicitud.

const PERSON = { select: { id: true, nombre: true, apellido: true } };

// El servicio enlazado a una solicitud, con lo que el cliente puede ver (aplicativo, targa, nombre del chofer y sus fotos de bolla).
const RECORD_ASIGNADO = {
  select: {
    aplicativo: true,
    vehicle: { select: { targa: true } },
    driver: { select: { nombre: true, apellido: true } },
    files: { where: { tipoArchivo: "BOLLA" }, orderBy: { createdAt: "asc" }, select: { id: true, archivoKey: true } },
  },
};

// Quien subio la solicitud (el usuario de la oficina o del cliente): nombre y cargo, para mostrar "Subido por".
const CREADOR = { select: { id: true, nombre: true, apellido: true, cargo: true, responsableTipo: true } };
const rolDe = (p) => (p.cargo === "ADMIN" ? (p.responsableTipo ? "Responsable" : "Admin") : p.cargo === "OWNER" ? "Owner" : p.cargo === "CLIENTE" ? "Cliente" : p.cargo);

const personName = (p) => (p ? `${p.nombre} ${p.apellido}`.trim() : null);

// Lo que se ve de un servicio ya creado a partir de la solicitud: el numero asignado (aplicativo), la targa y el nombre del chofer (nunca su telefono)
// y cuantas fotos de la bolla hay (solo si el usuario tiene el modulo FOTOS). Mismos datos que ya ve el cliente en su historial de servicios.
const asignadoDto = (record, { verFotos = false } = {}) =>
  record
    ? {
        aplicativo: record.aplicativo ?? null,
        targa: record.vehicle?.targa ?? null,
        chofer: record.driver ? personName(record.driver) : null,
        bollas: verFotos ? (record.files?.length ?? 0) : 0,
      }
    : null;

const toDto = (s, { office = false, verFotos = false } = {}) => ({
  id: s.id,
  servicio: s.servicio,
  servicioLabel: s.servicio === "EXTRA_PIAZZA" && s.zona ? `Extra Piazza ${s.zona === "ROMA" ? "Roma" : "Milano"}` : (SOLICITUD_SERVICIOS[s.servicio]?.label ?? s.servicio),
  zona: s.zona ?? null,
  cliente: s.cliente,
  destinazione: s.destinazione,
  fechaHora: s.fechaHora,
  etaPendiente: s.etaPendiente,
  km: s.km,
  kmTexto: s.kmTexto,
  pagato: s.pagato,
  pagato50: s.pagato50,
  fornitore: s.fornitore,
  autRitiro: s.autRitiro,
  varie: s.varie,
  varie2: s.varie2,
  descripcion: s.descripcion,
  aplicativo: s.aplicativo,
  ...(s.record !== undefined && !office ? { asignado: asignadoDto(s.record, { verFotos }) } : {}),
  choferIndicado: s.choferIndicado,
  ritiro: s.ritiro,
  shipment: s.shipment,
  orderNumero: s.orderNumero,
  tipoPedido: s.tipoPedido,
  estado: s.estado,
  motivoRechazo: s.motivoRechazo,
  createdAt: s.createdAt,
  recordId: s.recordId ?? null,
  ...(s.creadoPor ? { creadoPor: personName(s.creadoPor), creadoPorRol: rolDe(s.creadoPor) } : {}),
  ...(office ? { empresa: s.empresa?.nombre ?? null } : {}),
});

// --- Usuario cliente ---

export const requireRegistro = (user) => {
  if (!user.clienteModulos?.includes("REGISTRO")) throw new AppError("Non hai accesso a questa sezione", 403);
};

// Las solicitudes propias y las de su empresa (otros usuarios de la misma empresa cliente).
export const scopeWhere = (user) => ({ OR: [{ creadoPorId: user.id }, ...(user.clienteId ? [{ empresaId: user.clienteId }] : [])] });

const findOwned = async (user, id) => {
  const solicitud = await prisma.solicitudServicio.findFirst({ where: { id, ...scopeWhere(user) }, include: { creadoPor: CREADOR } });
  if (!solicitud) throw new AppError("Richiesta non trovata", 404);
  return solicitud;
};

// Mes (AAAA-MM) -> [desde, hasta) en hora de Roma.
const monthRange = (month) => {
  const [year, mon] = month.split("-").map(Number);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  return { gte: romeLocalToDate(`${month}-01`, "00:00"), lt: romeLocalToDate(`${next}-01`, "00:00") };
};

// Con month: las solicitudes de ese mes (como la hoja mensual del Excel). Sin month: las pendientes y las de los ultimos 60 dias.
export const listSolicitudesCliente = async (user, { month } = {}) => {
  requireRegistro(user);
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const when = month ? { fechaHora: monthRange(month) } : { OR: [{ estado: "PENDIENTE" }, { fechaHora: { gte: since } }] };
  const rows = await prisma.solicitudServicio.findMany({
    // Una solicitud aceptada cuyo servicio la oficina borro despues ya no existe para el cliente.
    where: { AND: [scopeWhere(user), when, { NOT: { estado: "ACEPTADA", recordId: null } }] },
    include: { record: RECORD_ASIGNADO, creadoPor: CREADOR },
    orderBy: { fechaHora: "desc" },
    take: 600,
  });
  const verFotos = Boolean(user.clienteModulos?.includes("FOTOS"));
  return rows.map((s) => toDto(s, { verFotos }));
};

// Detalle de una solicitud ya aceptada, para la fila desplegable de la hoja: chofer, targa, numero asignado y las fotos de la bolla (URL firmada).
export const getDetalleSolicitudCliente = async (user, id) => {
  requireRegistro(user);
  const solicitud = await findOwned(user, id);
  const verFotos = Boolean(user.clienteModulos?.includes("FOTOS"));
  const record = solicitud.recordId ? await prisma.record.findUnique({ where: { id: solicitud.recordId }, ...RECORD_ASIGNADO }) : null;
  const asignado = asignadoDto(record, { verFotos });
  const bollas = verFotos && record
    ? await Promise.all(
        record.files.map(async (f) => ({ id: f.id, url: await getSignedUrlForKey(f.archivoKey), esPdf: f.archivoKey.toLowerCase().endsWith(".pdf") }))
      )
    : [];
  return { asignado, bollas };
};

const ownerAndResponsableIds = async (servicio, zona) => {
  const areaKeys = areaKeysDeSolicitud(servicio, zona);
  const users = await prisma.user.findMany({
    where: { estado: "ACTIVO", OR: [{ cargo: "OWNER" }, { cargo: "ADMIN", areasPermitidas: { hasSome: areaKeys } }] },
    select: { id: true },
  });
  return users.map((u) => u.id);
};

const notifyOffice = async (solicitud, user) => {
  try {
    const ids = await ownerAndResponsableIds(solicitud.servicio, solicitud.zona);
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
  const solicitud = await prisma.solicitudServicio.create({
    data: { ...data, creadoPorId: user.id, empresaId: user.clienteId ?? null },
    include: { creadoPor: CREADOR },
  });
  void notifyOffice(solicitud, user);
  return toDto(solicitud);
};

export const updateSolicitudCliente = async (user, id, data) => {
  requireRegistro(user);
  const current = await findOwned(user, id);
  if (current.estado !== "PENDIENTE") throw new AppError("Si possono modificare solo le richieste in sospeso", 409);
  const solicitud = await prisma.solicitudServicio.update({ where: { id }, data, include: { creadoPor: CREADOR } });
  return toDto(solicitud);
};

export const deleteSolicitudCliente = async (user, id) => {
  requireRegistro(user);
  const current = await findOwned(user, id);
  if (current.estado === "ACEPTADA") throw new AppError("La richiesta è già stata accettata e non si può eliminare", 409);
  await prisma.solicitudServicio.delete({ where: { id } });
};

// --- Oficina (Admin y Responsables) ---

// Un Responsable solo ve las solicitudes de sus areas; el Admin ve todas.
const officeWhere = (actor) => {
  const keys = actorAreaKeys(actor);
  if (keys === null) return {};
  // Extra Piazza se reparte por zona: Milano (o sin zona) y Roma son areas distintas.
  const condiciones = Object.entries(SOLICITUD_SERVICIOS).flatMap(([tipo, def]) => {
    if (tipo !== "EXTRA_PIAZZA") return def.areaKeys.some((k) => keys.includes(k)) ? [{ servicio: tipo }] : [];
    const milano = keys.includes("piazza-milano");
    const roma = keys.includes("piazza-roma");
    if (milano && roma) return [{ servicio: tipo }];
    if (milano) return [{ servicio: tipo, OR: [{ zona: null }, { zona: "MILANO" }] }];
    return roma ? [{ servicio: tipo, zona: "ROMA" }] : [];
  });
  return { OR: condiciones };
};

const OFFICE_INCLUDE = { creadoPor: CREADOR, empresa: { select: { nombre: true } } };

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

// Aviso a quien subio la solicitud: en italiano si es un usuario cliente (Piazza), en espanol si es de la oficina.
const notifyCreator = (solicitud, es, it, actorId) => {
  if (solicitud.creadoPorId === actorId) return undefined;
  const { title, body } = solicitud.creadoPor?.cargo === "CLIENTE" ? it : es;
  return sendPushToUserIds([solicitud.creadoPorId], { title, body, data: { type: "solicitud", solicitudId: solicitud.id } }).catch(() => {});
};

export const rechazarSolicitudForActor = async (actor, id, { motivo }) => {
  const current = await findForActor(actor, id);
  if (current.estado !== "PENDIENTE") throw new AppError("La solicitud ya fue revisada", 409);
  const solicitud = await prisma.solicitudServicio.update({
    where: { id },
    data: { estado: "RECHAZADA", motivoRechazo: motivo ?? null, revisadoPorId: actor.id, revisadoAt: new Date() },
    include: OFFICE_INCLUDE,
  });
  const detalle = `${solicitud.cliente} - ${solicitud.destinazione}${motivo ? `: ${motivo}` : ""}`;
  void notifyCreator(solicitud, { title: "Solicitud rechazada", body: detalle }, { title: "Richiesta rifiutata", body: detalle }, actor.id);
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
    if (count) {
      const dato = `${current.cliente} - ${current.destinazione}`;
      void notifyCreator(current, { title: "Solicitud aceptada", body: `${dato} ya esta en el registro` }, { title: "Richiesta accettata", body: `${dato} è già nel registro` }, actor.id);
    }
    return count > 0;
  } catch (err) {
    console.error("No se pudo enlazar la solicitud con el servicio:", err.message);
    return false;
  }
};

// --- Servicio desde un texto pegado (oficina) ---
//  1. leerTextoForActor: el bot de reglas lee el texto y devuelve lo que entendio (Shipment, Order, cliente, tipo, ciudad, ETA) y los avisos. No guarda nada.
//  2. crearDesdeTextoForActor: con eso (corregido por quien pega), crea una solicitud PENDIENTE con el texto completo como descripcion.
//  3. La oficina la abre desde las pendientes, completa el resto del formulario y al crear el servicio queda aceptada (linkSolicitudToRecord).
// Por ahora solo DHL Milano.

const assertServicioDelActor = (actor, servicio, zona) => {
  const keys = actorAreaKeys(actor);
  if (keys !== null && !areaKeysDeSolicitud(servicio, zona).some((k) => keys.includes(k))) {
    throw new AppError("Non hai i permessi per questo tipo di servizio", 403);
  }
};

// Servicios o solicitudes pendientes que ya tienen ese Shipment u Order: para no cargar dos veces el mismo pedido. Los servicios viejos (sin las
// columnas nuevas) se reconocen porque el numero esta dentro de la descripcion.
const findDuplicados = async ({ shipment, orderNumero }) => {
  const numeros = [shipment, orderNumero].filter(Boolean);
  if (!numeros.length) return [];
  const [records, solicitudes] = await Promise.all([
    prisma.record.findMany({
      where: {
        OR: [
          ...(shipment ? [{ shipment }] : []),
          ...(orderNumero ? [{ orderNumero }] : []),
          ...numeros.map((n) => ({ descripcion: { contains: n } })),
        ],
      },
      select: { id: true, codigo: true, estado: true, fechaServicio: true },
      orderBy: { fechaServicio: "desc" },
      take: 3,
    }),
    prisma.solicitudServicio.findMany({
      where: { estado: "PENDIENTE", OR: [...(shipment ? [{ shipment }] : []), ...(orderNumero ? [{ orderNumero }] : [])] },
      select: { id: true, cliente: true, fechaHora: true },
      take: 3,
    }),
  ]);
  return [
    ...records.map((r) => ({ tipo: "SERVICIO", id: r.id, codigo: r.codigo, estado: r.estado, fecha: r.fechaServicio })),
    ...solicitudes.map((r) => ({ tipo: "SOLICITUD", id: r.id, cliente: r.cliente, fecha: r.fechaHora })),
  ];
};

// Localiza los lugares que nombra el mensaje (AB Service): Google con cache; "localizado" es la direccion que encontro o null si no la encuentra.
const localizarLugares = (lugares = []) =>
  Promise.all(
    lugares.slice(0, 4).map(async (l) => {
      // El deposito de AB Service ya esta localizado (coordenadas conocidas): no se consulta a Google.
      if (l.fijo) return { ...l, localizado: l.texto };
      try {
        return { ...l, localizado: (await geocodePreview(l.texto)) ?? l.texto };
      } catch {
        return { ...l, localizado: null };
      }
    })
  );

export const leerTextoForActor = async (actor, { servicio, zona, texto }) => {
  assertServicioDelActor(actor, servicio, zona);
  const clients = await prisma.client.findMany({ select: { id: true, nombre: true } });
  const { eta, ...parsed } = parseServicioTexto(texto, { clients, servicio });
  return { ...parsed, lugares: await localizarLugares(parsed.lugares), eta: eta?.toISOString() ?? null, duplicados: await findDuplicados(parsed) };
};

export const crearDesdeTextoForActor = async (actor, data) => {
  assertServicioDelActor(actor, data.servicio, data.zona);
  const solicitud = await prisma.solicitudServicio.create({
    data: { ...data, zona: data.servicio === "EXTRA_PIAZZA" ? (data.zona ?? "MILANO") : null, creadoPorId: actor.id, empresaId: null },
    include: OFFICE_INCLUDE,
  });
  return toDto(solicitud, { office: true });
};

// Lector de texto para el usuario cliente (Piazza): igual que el de la oficina pero sin lista de clientes (el "cliente" de la solicitud es el cliente
// final, texto libre) y los duplicados se buscan solo entre sus propias solicitudes.
export const leerTextoCliente = async (user, { servicio, texto }) => {
  requireRegistro(user);
  if (!SOLICITUD_SERVICIOS[servicio]) throw new AppError("Tipo di servizio non valido", 400);
  const { eta, ...parsed } = parseServicioTexto(texto, { servicio });
  const lugares = await localizarLugares(parsed.lugares);
  const numeros = [parsed.shipment && { shipment: parsed.shipment }, parsed.orderNumero && { orderNumero: parsed.orderNumero }].filter(Boolean);
  const repetidas = numeros.length
    ? await prisma.solicitudServicio.findMany({
        where: { AND: [scopeWhere(user), { OR: numeros }] },
        select: { id: true, cliente: true, fechaHora: true, estado: true },
        take: 3,
      })
    : [];
  return {
    ...parsed,
    lugares,
    eta: eta?.toISOString() ?? null,
    duplicados: repetidas.map((r) => ({ tipo: "SOLICITUD", id: r.id, cliente: r.cliente, estado: r.estado, fecha: r.fechaHora })),
  };
};

// Registrar con un solo paso (portal de Piazza): el cliente pega todo el texto y se crea la solicitud con lo que se pudo leer. Lo que falte (cliente, ciudad, ETA,
// codigos...) queda vacio y la hoja lo pinta en rojo para completarlo ahi mismo. Si ya hay una solicitud suya con el mismo Shipment / Order / codigo, avisa antes
// de duplicarla (confirmar = true la crea igual). Sin ninguna señal de que sea un servicio, no crea nada.
export const registrarDesdeTextoCliente = async (user, { servicio, texto, confirmar = false }) => {
  requireRegistro(user);
  if (!SOLICITUD_SERVICIOS[servicio]) throw new AppError("Tipo di servizio non valido", 400);
  const { eta, ...parsed } = parseServicioTexto(texto, { servicio });
  const legible = [parsed.shipment, parsed.orderNumero, parsed.ciudad, parsed.cliente, parsed.ritiro, eta].some(Boolean);
  if (!legible) throw new AppError("Non sono riuscito a leggere nessun dato dal testo: controlla di aver incollato il messaggio completo del servizio", 422);

  const numeros = [parsed.shipment && { shipment: parsed.shipment }, parsed.orderNumero && { orderNumero: parsed.orderNumero }].filter(Boolean);
  const repetidas = numeros.length
    ? await prisma.solicitudServicio.findMany({
        where: { AND: [scopeWhere(user), { OR: numeros }] },
        select: { id: true, cliente: true, fechaHora: true, estado: true, destinazione: true },
        take: 3,
      })
    : [];
  if (repetidas.length > 0 && !confirmar) {
    return {
      creada: false,
      duplicados: repetidas.map((r) => ({ id: r.id, cliente: r.cliente, destinazione: r.destinazione, estado: r.estado, fecha: r.fechaHora })),
      avisos: parsed.avisos,
    };
  }

  const solicitud = await prisma.solicitudServicio.create({
    data: {
      servicio,
      cliente: parsed.cliente ?? "",
      destinazione: parsed.ciudad ?? "",
      fechaHora: eta ?? new Date(),
      etaPendiente: !eta,
      km: parsed.km ?? null,
      descripcion: parsed.descripcion.slice(0, 4000),
      shipment: parsed.shipment,
      orderNumero: parsed.orderNumero,
      tipoPedido: parsed.tipoPedido,
      aplicativo: parsed.aplicativo,
      ritiro: parsed.ritiro,
      creadoPorId: user.id,
      empresaId: user.clienteId ?? null,
    },
    include: { creadoPor: CREADOR },
  });
  void notifyOffice(solicitud, user);
  return { creada: true, solicitud: toDto(solicitud), avisos: parsed.avisos };
};

// Ruta estimada ritiro -> consegna de una solicitud de Extra Piazza: solo una pista para quien escribe el KM a mano (nunca se guarda sola).
// Los giros ("Giro (4 tappe)") no tienen una sola entrega, asi que no se estiman.
export const rutaEstimadaForActor = async (actor, id) => {
  const s = await findForActor(actor, id);
  if (s.servicio !== "EXTRA_PIAZZA" || !s.ritiro || !s.destinazione || /^giro\b/i.test(s.destinazione)) return { km: null };
  try {
    const [a, b] = await Promise.all([geocodeAddress(s.ritiro), geocodeAddress(s.destinazione)]);
    const ruta = await calculateRoute([a, b]);
    return { km: ruta ? Math.round(ruta.distanciaKm * 10) / 10 : null };
  } catch {
    return { km: null };
  }
};

// Al borrar un servicio de la oficina, la solicitud del cliente que lo origino se borra tambien (si no, el cliente seguiria viendo una fila fantasma).
export const deleteSolicitudesOfRecord = (recordId) => prisma.solicitudServicio.deleteMany({ where: { recordId } });
