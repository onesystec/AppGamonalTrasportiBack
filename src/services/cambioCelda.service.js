import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { actorAreaKeys, canAccessAreaKey, recordAreaKey } from "../utils/areaAccess.js";
import { romeLocalToDate } from "../utils/romeTime.js";
import { clienteScopeWhere } from "./cliente.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { requireRegistro, scopeWhere } from "./solicitud.service.js";

// Edicion de celdas de la hoja tipo Excel del portal de clientes (los mensajes de error van en italiano, como esa pantalla).
//  - Solicitud pendiente: el cliente puede cambiar todo lo que cargo.
//  - Servicio ya creado (o solicitud aceptada, que es ese servicio): solo Shipment/Order, Tipo, Ciudad y ETA; el cliente (la ficha que se factura), los km
//    y el numero de zona los decide la oficina.
//  - Cada cambio queda en el historial (CambioServicio). Si el servicio ya esta entregado (CONSEGNATO) ademas se avisa a la oficina (AlertaCambio + push):
//    los cambios de la misma persona en el mismo servicio durante 10 minutos se juntan en una sola alerta.

const CAMPOS_SOLICITUD = ["shipment", "orderNumero", "tipoPedido", "cliente", "ciudad", "eta", "km", "aplicativo", "ritiro"];
const CAMPOS_SERVICIO = ["shipment", "orderNumero", "tipoPedido", "ciudad", "eta"];
const VENTANA_ALERTA_MS = 10 * 60 * 1000;

const AREA_LABEL = { "dhl-milano": "DHL Milano", "dhl-roma": "DHL Roma", "ab-service": "AB Service", "piazza-milano": "Extra Piazza", "piazza-roma": "Extra Piazza", otros: "Otros" };
const esExtraArea = (areaKey) => areaKey === "piazza-milano" || areaKey === "piazza-roma";

// Nombre del dato para quien lo lee en la oficina (en Extra Piazza el Shipment es el codigo y la ciudad es la consegna).
export const labelDeCampo = (campo, areaKey) => {
  const extra = esExtraArea(areaKey);
  const base = {
    shipment: extra ? "Codice" : "Shipment",
    orderNumero: extra ? "Secondo codice" : "Order",
    tipoPedido: "Tipo",
    cliente: "Cliente",
    ciudad: extra ? "Consegna" : "Ciudad",
    eta: "ETA",
    km: "KM",
    aplicativo: "Número",
    ritiro: "Ritiro",
  };
  return base[campo] ?? campo;
};

const FECHA_CORTA = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fechaCorta = (date) => {
  const p = Object.fromEntries(FECHA_CORTA.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};

// Como se ve un valor en el historial y en las alertas (null = vacio).
const visible = (campo, valor) => {
  if (valor == null || valor === "") return null;
  if (campo === "eta") return fechaCorta(new Date(valor));
  if (campo === "aplicativo") return String(valor).replace("_", " ");
  return String(valor);
};

const invalido = (msg) => new AppError(msg, 422);

// Valor escrito en la celda -> lo que se guarda. Devuelve { valor, extra?, visibleTexto? } (valor = la forma comparable con la actual).
const normalizar = (campo, crudo, { zona, clienteObligatorio }) => {
  const texto = typeof crudo === "string" ? crudo.trim() : crudo == null ? "" : String(crudo).trim();
  const textoMax = (max, obligatorio, nombre) => {
    if (!texto && obligatorio) throw invalido(`${nombre} è obbligatorio`);
    if (texto.length > max) throw invalido(`${nombre} è troppo lungo`);
    return texto || null;
  };
  switch (campo) {
    case "shipment":
    case "orderNumero":
      return { valor: textoMax(60, false, "Il valore") };
    case "ritiro":
      return { valor: textoMax(250, false, "Il ritiro") };
    case "cliente":
      return { valor: textoMax(150, clienteObligatorio, "Il cliente") };
    case "ciudad":
      return { valor: textoMax(250, true, "La città") };
    case "tipoPedido": {
      const t = texto.toUpperCase();
      if (!t) return { valor: null };
      if (t !== "ASAP" && t !== "SCHEDULED") throw invalido("Tipo non valido (ASAP o SCHEDULED)");
      return { valor: t };
    }
    case "eta": {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(texto);
      const fecha = m ? romeLocalToDate(m[1], m[2]) : null;
      if (!fecha || Number.isNaN(fecha.getTime())) throw invalido("La data e l'ora non sono valide");
      return { valor: fecha };
    }
    case "km": {
      if (!texto) return { valor: null, extra: { kmTexto: null } };
      const num = /^(\d+(?:[.,]\d+)?)\s*(?:km)?$/i.exec(texto);
      if (num) return { valor: Number(num[1].replace(",", ".")), extra: { kmTexto: null } };
      return { valor: null, extra: { kmTexto: texto.slice(0, 100) }, visibleTexto: texto.slice(0, 100) };
    }
    case "aplicativo": {
      if (!texto) return { valor: null };
      const n = /^(?:(?:milano|roma)[_ ]?)?(\d{1,2})$/i.exec(texto);
      const max = zona === "ROMA" ? 10 : 18;
      const num = n ? Number(n[1]) : 0;
      if (!zona || num < 1 || num > max) throw invalido(`Numero non valido (da 1 a ${max})`);
      return { valor: `${zona}_${num}` };
    }
    default:
      throw invalido("Dato non modificabile");
  }
};

const mismoValor = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a ?? 0).getTime() === new Date(b ?? 0).getTime() : (a ?? null) === (b ?? null));

// Aplica los cambios pedidos a un objeto actual { campo: valor }: devuelve los que de verdad cambian, ya normalizados y con su antes/despues.
const calcularCambios = (cambios, actual, permitidos, ctx) => {
  const resultado = [];
  for (const [campo, crudo] of Object.entries(cambios)) {
    if (!permitidos.includes(campo)) throw new AppError("Questo dato lo modifica solo l'ufficio", 403);
    const n = normalizar(campo, crudo, ctx);
    const anterior = actual[campo] ?? null;
    if (mismoValor(n.valor, anterior)) continue;
    resultado.push({ campo, nuevo: n.valor, extra: n.extra, anteriorVisible: visible(campo, anterior), nuevoVisible: n.visibleTexto ?? visible(campo, n.valor) });
  }
  return resultado;
};

const editorNombre = (user) => `${user.nombre} ${user.apellido}`.trim() + (user.cliente?.nombre ? ` (${user.cliente.nombre})` : "");

const filaHistorial = (c, user, destino) => ({ ...destino, campo: c.campo, anterior: c.anteriorVisible, nuevo: c.nuevoVisible, editorId: user.id, editorNombre: editorNombre(user) });

// --- Alertas (servicio ya entregado) ---

const textoAlerta = (editor, titulo, cambios) => {
  const una = (c) => `${c.label}: ${c.anterior ?? "—"} → ${c.nuevo ?? "—"}`;
  const cuerpo = cambios.length === 1 ? `${editor} cambió ${una(cambios[0])} en ${titulo}` : `${editor} cambió en ${titulo}: ${cambios.map(una).join("; ")}`;
  return cuerpo.length > 220 ? `${cuerpo.slice(0, 217)}…` : cuerpo;
};

const idsDeLaOficina = async (areaKey) => {
  const users = await prisma.user.findMany({
    where: { estado: "ACTIVO", OR: [{ cargo: "OWNER" }, { cargo: "ADMIN", areasPermitidas: { has: areaKey } }] },
    select: { id: true },
  });
  return users.map((u) => u.id);
};

const registrarAlerta = async (user, record, cambios) => {
  const areaKey = recordAreaKey(record);
  const titulo = `${AREA_LABEL[areaKey] ?? areaKey} ${record.shipment ?? record.codigo}`;
  const nuevos = cambios.map((c) => ({ campo: c.campo, label: labelDeCampo(c.campo, areaKey), anterior: c.anteriorVisible, nuevo: c.nuevoVisible }));
  const existente = await prisma.alertaCambio.findFirst({
    where: { recordId: record.id, editorId: user.id, updatedAt: { gte: new Date(Date.now() - VENTANA_ALERTA_MS) } },
    orderBy: { updatedAt: "desc" },
  });
  if (existente) {
    // Se junta con la alerta abierta: de cada dato queda el valor de antes del primer cambio y el de ahora (si volvio a como estaba, ya no es un cambio).
    const mapa = new Map(existente.cambios.map((c) => [c.campo, c]));
    for (const c of nuevos) {
      const previo = mapa.get(c.campo);
      mapa.set(c.campo, previo ? { ...previo, nuevo: c.nuevo } : c);
    }
    const juntos = [...mapa.values()].filter((c) => (c.anterior ?? null) !== (c.nuevo ?? null));
    if (juntos.length === 0) {
      await prisma.alertaCambio.delete({ where: { id: existente.id } });
      return;
    }
    // Vuelve a quedar como "no leida" para todos; no se manda otro push (el detalle completo esta en la lista).
    await prisma.alertaCambio.update({ where: { id: existente.id }, data: { cambios: juntos, leidoPor: [] } });
    return;
  }
  const alerta = await prisma.alertaCambio.create({
    data: { recordId: record.id, areaKey, titulo, editorId: user.id, editorNombre: editorNombre(user), cambios: nuevos },
  });
  try {
    const ids = await idsDeLaOficina(areaKey);
    await sendPushToUserIds(ids, {
      title: "Servicio editado después de entregarse",
      body: textoAlerta(alerta.editorNombre, titulo, nuevos),
      data: { type: "cambio-servicio", alertaId: alerta.id, recordId: record.id },
    });
  } catch {
    // Best-effort: un fallo de push no debe romper la edicion.
  }
};

// --- Edicion ---

const editarSolicitud = async (user, s, cambios) => {
  const zona = s.servicio === "DHL_ROMA" ? "ROMA" : s.servicio === "DHL_MILANO" ? "MILANO" : null;
  const actual = {
    shipment: s.shipment,
    orderNumero: s.orderNumero,
    tipoPedido: s.tipoPedido,
    cliente: s.cliente,
    ciudad: s.destinazione,
    eta: s.fechaHora,
    km: s.km ?? s.kmTexto,
    aplicativo: s.aplicativo,
    ritiro: s.ritiro,
  };
  const aplicados = calcularCambios(cambios, actual, CAMPOS_SOLICITUD, { zona, clienteObligatorio: s.servicio !== "EXTRA_PIAZZA" });
  if (aplicados.length === 0) return { cambiados: 0 };
  const data = {};
  for (const c of aplicados) {
    if (c.campo === "ciudad") data.destinazione = c.nuevo;
    else if (c.campo === "eta") data.fechaHora = c.nuevo;
    else if (c.campo === "km") Object.assign(data, { km: c.nuevo, ...c.extra });
    else if (c.campo === "cliente") data.cliente = c.nuevo ?? "";
    else data[c.campo] = c.nuevo;
  }
  await prisma.$transaction([
    prisma.solicitudServicio.update({ where: { id: s.id }, data }),
    prisma.cambioServicio.createMany({ data: aplicados.map((c) => filaHistorial(c, user, { solicitudId: s.id })) }),
  ]);
  return { cambiados: aplicados.length };
};

const editarServicio = async (user, recordId, cambios, solicitudId = null) => {
  const record = await prisma.record.findFirst({
    where: { AND: [{ id: recordId }, clienteScopeWhere(user)] },
    select: { id: true, codigo: true, estado: true, shipment: true, orderNumero: true, tipoPedido: true, ciudad: true, eta: true, spedizzione: true, extrasPiazzaZona: true },
  });
  if (!record) throw new AppError("Servizio non trovato", 404);
  const actual = { shipment: record.shipment, orderNumero: record.orderNumero, tipoPedido: record.tipoPedido, ciudad: record.ciudad, eta: record.eta };
  const aplicados = calcularCambios(cambios, actual, CAMPOS_SERVICIO, { zona: null, clienteObligatorio: false });
  if (aplicados.length === 0) return { cambiados: 0 };
  const data = Object.fromEntries(aplicados.map((c) => [c.campo, c.nuevo]));
  await prisma.$transaction([
    prisma.record.update({ where: { id: record.id }, data }),
    prisma.cambioServicio.createMany({ data: aplicados.map((c) => filaHistorial(c, user, { recordId: record.id, solicitudId })) }),
  ]);
  if (record.estado === "CONSEGNATO") await registrarAlerta(user, { ...record, ...data }, aplicados);
  return { cambiados: aplicados.length };
};

// origen: "solicitud" | "servicio"; cambios: { campo: valor } (valor tal como se escribio en la celda).
export const editarCeldaCliente = async (user, { origen, id, cambios }) => {
  requireRegistro(user);
  if (origen === "servicio") return editarServicio(user, id, cambios);
  const s = await prisma.solicitudServicio.findFirst({ where: { id, ...scopeWhere(user) } });
  if (!s) throw new AppError("Richiesta non trovata", 404);
  if (s.estado === "RECHAZADA") throw new AppError("La richiesta è stata rifiutata: non si può modificare", 409);
  // Una solicitud aceptada es ese servicio: se edita el servicio (con sus limites y, si ya se entrego, la alerta).
  if (s.estado === "ACEPTADA") {
    if (!s.recordId) throw new AppError("La richiesta è già stata accettata", 409);
    return editarServicio(user, s.recordId, cambios, s.id);
  }
  return editarSolicitud(user, s, cambios);
};

// --- Oficina (Owner y Admin) ---

const areaWhere = (actor) => {
  const keys = actorAreaKeys(actor);
  return keys === null ? {} : { areaKey: { in: keys } };
};

const alertaDto = (a, actorId) => ({
  id: a.id,
  recordId: a.recordId,
  areaKey: a.areaKey,
  titulo: a.titulo,
  editor: a.editorNombre,
  cambios: a.cambios,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  noLeida: !a.leidoPor.includes(actorId),
});

export const listAlertasCambio = async (actor) => {
  const rows = await prisma.alertaCambio.findMany({ where: areaWhere(actor), orderBy: { updatedAt: "desc" }, take: 100 });
  const items = rows.map((a) => alertaDto(a, actor.id));
  return { items, noLeidas: items.filter((i) => i.noLeida).length };
};

export const marcarAlertasLeidas = async (actor, ids) => {
  const rows = await prisma.alertaCambio.findMany({ where: { ...areaWhere(actor), ...(ids?.length ? { id: { in: ids } } : {}) }, select: { id: true, leidoPor: true } });
  await Promise.all(
    rows.filter((r) => !r.leidoPor.includes(actor.id)).map((r) => prisma.alertaCambio.update({ where: { id: r.id }, data: { leidoPor: [...r.leidoPor, actor.id] } }))
  );
};

// Historial de cambios de un servicio (los de su solicitud incluidos), para el detalle en la oficina.
export const historialCambiosServicio = async (actor, recordId) => {
  const record = await prisma.record.findUnique({ where: { id: recordId }, select: { id: true, spedizzione: true, extrasPiazzaZona: true } });
  if (!record) throw new AppError("Servicio no encontrado", 404);
  const areaKey = recordAreaKey(record);
  if (!canAccessAreaKey(actor, areaKey)) throw new AppError("No tienes acceso a este servicio", 403);
  const solicitud = await prisma.solicitudServicio.findFirst({ where: { recordId }, select: { id: true } });
  const rows = await prisma.cambioServicio.findMany({
    where: { OR: [{ recordId }, ...(solicitud ? [{ solicitudId: solicitud.id }] : [])] },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((c) => ({ id: c.id, campo: c.campo, label: labelDeCampo(c.campo, areaKey), anterior: c.anterior, nuevo: c.nuevo, editor: c.editorNombre, createdAt: c.createdAt }));
};
