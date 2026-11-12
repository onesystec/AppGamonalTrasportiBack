import { prisma } from "../config/prisma.js";
import { SOLICITUD_SERVICIOS } from "../constants/solicitudes.js";
import { createRecord } from "./record.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { getSinAsignar } from "./sinAsignar.service.js";

// Servicios directos: las empresas cliente con Client.serviciosDirectos (Piazza Spedizioni) no pasan por la solicitud pendiente. Al enviar el servicio desde el
// portal, el servicio aparece de una vez en el Registro, con chofer y vehiculo "Sin asignar" (ver sinAsignar.service.js) hasta que la oficina elija los reales.
// La solicitud se conserva, ya ACEPTADA y enlazada al servicio, porque es lo que alimenta la hoja y el historial del cliente (y sus ediciones de celda).
// Si el servicio no se puede crear (la direccion no se ubica en el mapa, falla algun servicio externo...), la solicitud queda PENDIENTE como siempre y la
// oficina la completa a mano: el cliente nunca pierde lo que envio.

export const usaServiciosDirectos = async (user) => {
  if (!user?.clienteId) return false;
  const client = await prisma.client.findUnique({ where: { id: user.clienteId }, select: { serviciosDirectos: true } });
  return Boolean(client?.serviciosDirectos);
};

const normalizar = (valor) =>
  String(valor ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const SIN_CLIENTE = "Por completar";

// Codigo interno unico "TIPO-<milisegundos>" (el formato que reconoce codigoDhl.service.js para reemplazarlo por el Shipment en DHL). Siempre creciente: dos
// servicios en el mismo milisegundo no repiten codigo.
let ultimoSello = 0;
const sello = () => {
  ultimoSello = Math.max(Date.now(), ultimoSello + 1);
  return ultimoSello;
};

// Ficha de Client que se factura: la que se llama como el cliente escrito (sin importar mayusculas ni acentos); en AB Service el cliente del servicio es siempre
// AB (lo escrito es el cliente final). Si no existe se crea con ese nombre (queda a la vista en Clientes para que la oficina la revise); sin nombre, "Por completar".
export const resolverClientePorNombre = async (nombreCrudo, { abService = false } = {}) => {
  const clients = await prisma.client.findMany({ select: { id: true, nombre: true } });
  const buscar = (nombre) => clients.find((c) => normalizar(c.nombre) === normalizar(nombre));
  const nombre = (nombreCrudo ?? "").trim();
  const hit = (nombre && buscar(nombre)) || (abService ? buscar("AB") : null) || (!nombre ? buscar(SIN_CLIENTE) : null);
  if (hit) return hit.id;
  const creado = await prisma.client.create({ data: { nombre: nombre || SIN_CLIENTE }, select: { id: true } });
  return creado.id;
};
const resolverCliente = (solicitud) => resolverClientePorNombre(solicitud.cliente, { abService: solicitud.servicio === "AB_SERVICE" });

const nombrePais = (codigo) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(codigo) ?? codigo;
  } catch {
    return codigo;
  }
};

// Misma direccion que arma el formulario del servicio: una solicitud leida de un texto trae solo la ciudad en "destinazione" (y calle y CAP aparte); una
// escrita por el cliente trae la direccion de entrega completa. Fuera de Italia se agrega el pais, para que el mapa no lo busque en Italia.
const direccionDeEntrega = (s) => {
  const deTexto = Boolean(s.shipment || s.orderNumero);
  if (!deTexto) return { direccion: s.destinazione.trim(), ciudad: undefined };
  const capCiudad = [(s.cap ?? "").trim(), s.destinazione.trim()].filter(Boolean).join(" ");
  const partes = [(s.calle ?? "").trim(), capCiudad, s.pais && s.pais !== "IT" ? nombrePais(s.pais) : ""].filter(Boolean);
  return { direccion: partes.join(", "), ciudad: s.destinazione.trim() };
};

// Lo mismo que la oficina pone de partida al abrir una solicitud (solicitudToFormDefaults del frontend): la descripcion junta lo que no tiene casilla propia.
const descripcionDe = (s) =>
  [s.descripcion, s.ritiro ? `Ritiro: ${s.ritiro}` : null, s.varie, s.kmTexto ? `KM: ${s.kmTexto}` : null, s.autRitiro ? `Aut. ritiro: ${s.autRitiro}` : null, s.pagato50 ? "Pagato al 50%" : null]
    .filter((v) => v && String(v).trim())
    .join("\n") || (s.cliente ? `Solicitud de ${s.cliente}` : "Servicio cargado desde el portal del cliente");

export const crearServicioDirecto = async (solicitud) => {
  const tipo = SOLICITUD_SERVICIOS[solicitud.servicio];
  if (!tipo) throw new Error(`Tipo de servicio desconocido: ${solicitud.servicio}`);
  if (!solicitud.destinazione?.trim()) throw new Error("Sin direccion de entrega: lo completa la oficina");
  const zona = solicitud.servicio === "EXTRA_PIAZZA" ? (solicitud.zona ?? "MILANO") : tipo.zona;
  const [{ driverId, vehicleId }, clientId] = await Promise.all([getSinAsignar(), resolverCliente(solicitud)]);
  const { direccion, ciudad } = direccionDeEntrega(solicitud);

  const data = {
    driverId,
    vehicleId,
    clientId,
    eta: solicitud.fechaHora,
    descripcion: descripcionDe(solicitud),
    // DHL: el servidor lo reemplaza por el Shipment (ese es el codigo del servicio); en los demas es un codigo interno unico.
    codigo: `${tipo.spedizzione}-${sello()}`,
    spedizzione: tipo.spedizzione,
    extrasPiazzaZona: zona,
    stops: [{ direccion }],
    ...(ciudad ? { ciudad } : {}),
    ...(solicitud.pais ? { pais: solicitud.pais } : {}),
    ...(solicitud.km > 0 ? { kilometros: solicitud.km } : {}),
    ...(solicitud.pagato != null ? { pagoRecibido: solicitud.pagato } : {}),
    ...(solicitud.varie2 != null ? { costoEspera: solicitud.varie2 } : {}),
    ...(solicitud.servicio !== "EXTRA_PIAZZA" && solicitud.shipment ? { shipment: solicitud.shipment } : {}),
    ...(solicitud.servicio !== "EXTRA_PIAZZA" && solicitud.orderNumero ? { orderNumero: solicitud.orderNumero } : {}),
    ...(solicitud.tipoPedido ? { tipoPedido: solicitud.tipoPedido } : {}),
    ...(solicitud.aplicativo?.startsWith(`${zona}_`) ? { aplicativo: solicitud.aplicativo } : {}),
  };
  // actor = null: proceso de confianza (no es una persona de la oficina creando un servicio, no hay area que validar).
  return createRecord(data, { skipDriverCheck: true });
};

// Intenta registrar la solicitud recien creada como servicio. Devuelve { solicitud, record }: con record = null la solicitud sigue pendiente.
export const intentarServicioDirecto = async (solicitud, user, include) => {
  if (!(await usaServiciosDirectos(user))) return { solicitud, record: null };
  try {
    const record = await crearServicioDirecto(solicitud);
    const aceptada = await prisma.solicitudServicio.update({
      where: { id: solicitud.id },
      data: { estado: "ACEPTADA", recordId: record.id, revisadoAt: new Date(), motivoRechazo: null },
      include,
    });
    return { solicitud: aceptada, record };
  } catch (err) {
    console.error("[servicio-directo] no se pudo crear el servicio, queda como solicitud pendiente:", err.message);
    return { solicitud, record: null };
  }
};

// Aviso a la oficina: ya no hay nada que aceptar, pero hay un servicio nuevo sin chofer ni vehiculo.
export const avisarServicioDirecto = async (solicitud, record, user, ids) => {
  try {
    await sendPushToUserIds(ids, {
      title: "Nuevo servicio sin asignar",
      body: `${user.cliente?.nombre ?? `${user.nombre} ${user.apellido}`}: ${solicitud.cliente || "-"} - ${solicitud.destinazione}`,
      data: { type: "servicio-directo", recordId: record.id },
    });
  } catch {
    // Best-effort: un fallo de push no debe romper el envio.
  }
};
