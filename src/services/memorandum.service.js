import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { AREA_KEYS, AREA_LABELS } from "../constants/areas.js";
import { MEMO_EMISOR_LABEL, MEMO_TIPOS, MEMO_TIPO_KEYS } from "../constants/memorandums.js";
import { AppError } from "../utils/AppError.js";
import { recordAreaWhere } from "../utils/areaAccess.js";
import { romeDay, romeLocalToDate } from "../utils/romeTime.js";
import { buildMemorandumPdf } from "./memorandumPdf.service.js";
import { getOfficeScope } from "./notificationScope.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { forgetMemorandum, trackMemorandumRecipients } from "./memorandumAvisos.service.js";

// Memorandums: comunicados formales con el logo de la empresa que se escriben en la app. Quien emite: el Admin (OWNER), Recursos Humanos
// (a cualquiera) y los Responsables (solo a los choferes de sus areas, y solo algunos tipos). Cada destinatario tiene que dar su acuse
// (un toque) o su firma antes de poder abrirlo, como la busta paga. Una vez que alguien lo firma ya no se puede borrar.
const FILE_URL_SECONDS = 120;
const RECENT_MS = 60 * 24 * 60 * 60 * 1000;

const isOffice = (actor) => actor.cargo === "OWNER" || actor.cargo === "RRHH";
const canEmit = (actor) => isOffice(actor) || actor.cargo === "ADMIN";

const clip = (value, max) => (value ? String(value).slice(0, max) : null);
const fullName = (u) => (u ? `${u.nombre} ${u.apellido}` : null);
const log = (memorandumId, usuarioId, accion, meta) =>
  prisma.memorandumAcceso.create({ data: { memorandumId, usuarioId, accion, ip: clip(meta?.ip, 64), dispositivo: clip(meta?.dispositivo, 300) } });

const assertCanEmit = (actor) => {
  if (!canEmit(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
};

// Choferes que trabajaron en servicios de esas areas en los ultimos 60 dias.
const choferesDeAreas = async (areaKeys) => {
  if (areaKeys.length === 0) return [];
  const rows = await prisma.record.findMany({
    where: { fechaServicio: { gte: new Date(Date.now() - RECENT_MS) }, ...recordAreaWhere({ cargo: "ADMIN", areasPermitidas: areaKeys }) },
    distinct: ["driverId"],
    select: { driverId: true },
  });
  return rows.map((r) => r.driverId);
};

const USER_SELECT = { id: true, nombre: true, apellido: true, cargo: true };

// Areas que puede elegir quien emite: el Responsable solo las suyas.
const areasFor = (actor) => (actor.cargo === "ADMIN" ? (actor.areasPermitidas ?? []).filter((k) => AREA_KEYS.includes(k)) : AREA_KEYS);

// Todo lo que puede elegir quien emite: tipos, areas y personas.
export const getEmitOptionsForActor = async (actor) => {
  assertCanEmit(actor);
  const tipos = MEMO_TIPO_KEYS.filter((k) => MEMO_TIPOS[k].roles.includes(actor.cargo)).map((k) => ({
    key: k,
    label: MEMO_TIPOS[k].label,
    descripcion: MEMO_TIPOS[k].descripcion,
    nivel: MEMO_TIPOS[k].nivel,
    nivelFijo: Boolean(MEMO_TIPOS[k].fijo),
    plantilla: MEMO_TIPOS[k].plantilla,
  }));

  let personas;
  if (actor.cargo === "ADMIN") {
    const scope = await getOfficeScope(actor);
    personas = await prisma.user.findMany({
      where: { id: { in: scope?.driverIds ?? [] }, cargo: "CHOFER", estado: "ACTIVO" },
      select: USER_SELECT,
      orderBy: [{ nombre: "asc" }, { apellido: "asc" }],
    });
  } else {
    personas = await prisma.user.findMany({
      where: { cargo: { in: ["CHOFER", "ADMIN", "RRHH", "OWNER"] }, estado: "ACTIVO", id: { not: actor.id } },
      select: USER_SELECT,
      orderBy: [{ nombre: "asc" }, { apellido: "asc" }],
    });
  }
  return {
    tipos,
    areas: areasFor(actor).map((key) => ({ key, label: AREA_LABELS[key] })),
    modos: isOffice(actor) ? ["CHOFERES", "RESPONSABLES", "AREA", "PERSONAS"] : ["CHOFERES", "AREA", "PERSONAS"],
    personas,
  };
};

// A quienes va el memorandum segun lo que eligio quien emite (y lo que le permite su cargo). Devuelve las personas y el texto de la audiencia.
const resolveRecipients = async (actor, spec) => {
  const modo = spec.modo;
  const base = { estado: "ACTIVO", id: { not: actor.id } };
  const office = isOffice(actor);

  if (modo === "RESPONSABLES") {
    if (!office) throw new AppError("No puedes enviar memorandums a los Responsables", 403);
    const users = await prisma.user.findMany({ where: { ...base, cargo: "ADMIN" }, select: USER_SELECT });
    return { users, audiencia: "Todos los Responsables" };
  }

  // Los choferes a los que puede llegar: todos (Admin y RRHH) o los de su asignacion (Responsable).
  let allowedIds = null;
  if (!office) allowedIds = (await getOfficeScope(actor))?.driverIds ?? [];
  const inScope = allowedIds ? { id: { in: allowedIds, not: actor.id } } : {};

  if (modo === "CHOFERES") {
    const users = await prisma.user.findMany({ where: { ...base, ...inScope, cargo: "CHOFER" }, select: USER_SELECT });
    return { users, audiencia: office ? "Todos los choferes" : "Mis choferes" };
  }

  if (modo === "AREA") {
    const permitidas = areasFor(actor);
    const keys = (spec.areas ?? []).filter((k) => permitidas.includes(k));
    if (keys.length === 0) throw new AppError("Elige al menos una zona", 400);
    const ids = await choferesDeAreas(keys);
    const visibles = allowedIds ? ids.filter((id) => allowedIds.includes(id)) : ids;
    const users = await prisma.user.findMany({ where: { ...base, id: { in: visibles, not: actor.id }, cargo: "CHOFER" }, select: USER_SELECT });
    return { users, audiencia: `Choferes de ${keys.map((k) => AREA_LABELS[k]).join(", ")}` };
  }

  // PERSONAS
  const ids = [...new Set(spec.userIds ?? [])];
  if (ids.length === 0) throw new AppError("Elige al menos una persona", 400);
  const users = await prisma.user.findMany({
    where: {
      ...base,
      id: { in: allowedIds ? ids.filter((id) => allowedIds.includes(id)) : ids, not: actor.id },
      cargo: allowedIds ? "CHOFER" : { in: ["CHOFER", "ADMIN", "RRHH", "OWNER"] },
    },
    select: USER_SELECT,
  });
  const audiencia =
    users.length === 1 ? fullName(users[0]) : users.length <= 3 ? users.map(fullName).join(", ") : `${users.length} personas`;
  return { users, audiencia };
};

// Fin del dia (23:59 de Roma) de hoy mas N dias.
const plazoDesdeDias = (dias) => {
  const [y, m, d] = romeDay().split("-").map(Number);
  return romeLocalToDate(new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10), "23:59");
};

const nextNumero = async (anio) => {
  const last = await prisma.memorandum.findFirst({ where: { anio }, orderBy: { secuencia: "desc" }, select: { secuencia: true } });
  const secuencia = (last?.secuencia ?? 0) + 1;
  return { secuencia, numero: `MEMO-${anio}-${String(secuencia).padStart(3, "0")}` };
};

const toListItem = (m, extra = {}) => ({
  id: m.id,
  numero: m.numero,
  tipo: m.tipo,
  tipoLabel: MEMO_TIPOS[m.tipo]?.label ?? m.tipo,
  titulo: m.titulo,
  nivelFirma: m.nivelFirma,
  emisor: fullName(m.emisor),
  emisorRol: MEMO_EMISOR_LABEL[m.emisor?.cargo] ?? null,
  audiencia: m.audiencia,
  plazoAt: m.plazoAt,
  createdAt: m.createdAt,
  ...extra,
});

const EMISOR_SELECT = { select: { nombre: true, apellido: true, cargo: true } };

export const emitMemorandumForActor = async (actor, body, meta) => {
  assertCanEmit(actor);
  const tipoCfg = MEMO_TIPOS[body.tipo];
  if (!tipoCfg || !tipoCfg.roles.includes(actor.cargo)) throw new AppError("No puedes emitir este tipo de memorandum", 403);

  const { users, audiencia } = await resolveRecipients(actor, body.destinatarios);
  if (users.length === 0) throw new AppError("No hay destinatarios para ese memorandum", 400);

  const nivelFirma = tipoCfg.fijo ? tipoCfg.nivel : (body.nivelFirma ?? tipoCfg.nivel);
  const plazoAt = body.plazoDias ? plazoDesdeDias(body.plazoDias) : null;
  const ahora = new Date();
  const anio = Number(romeDay().slice(0, 4));
  const titulo = body.titulo.trim();
  const cuerpo = body.cuerpo.trim();

  let created;
  for (let intento = 0; intento < 3 && !created; intento += 1) {
    const { secuencia, numero } = await nextNumero(anio);
    const pdf = await buildMemorandumPdf({
      numero,
      tipo: body.tipo,
      titulo,
      cuerpo,
      emisor: fullName(actor),
      emisorRol: MEMO_EMISOR_LABEL[actor.cargo],
      audiencia,
      fecha: ahora,
      plazoAt,
      nivelFirma,
    });
    const archivoKey = `memorandums/${anio}/${numero}-${randomUUID()}.pdf`;
    await uploadObject(archivoKey, pdf, "application/pdf");
    try {
      created = await prisma.memorandum.create({
        data: {
          numero,
          anio,
          secuencia,
          tipo: body.tipo,
          titulo,
          cuerpo,
          nivelFirma,
          emisorId: actor.id,
          audiencia,
          plazoAt,
          archivoKey,
          archivoHash: createHash("sha256").update(pdf).digest("hex"),
          destinatarios: { create: users.map((u) => ({ userId: u.id, ultimoAvisoAt: ahora, avisos: 1 })) },
        },
        include: { emisor: EMISOR_SELECT, destinatarios: { select: { id: true, userId: true } } },
      });
    } catch (err) {
      await deleteObject(archivoKey).catch(() => {});
      // Otro memorandum tomo el mismo numero justo ahora: se vuelve a intentar con el siguiente.
      if (err.code !== "P2002" || intento === 2) throw err;
    }
  }

  await log(created.id, actor.id, "EMISION", meta);
  trackMemorandumRecipients(
    created.destinatarios.map((d) => ({ id: d.id, memorandumId: created.id, userId: d.userId, createdAt: created.createdAt, plazoAt, ultimoAvisoAt: ahora, titulo, numero: created.numero }))
  );

  sendPushToUserIds(
    users.map((u) => u.id),
    {
      title: `Nuevo memorándum: ${titulo}`,
      body: nivelFirma === "FIRMA" ? "Tienes un memorándum pendiente de tu firma." : "Tienes un memorándum pendiente de confirmar.",
      data: { type: "memorandum", id: created.id },
    }
  ).catch((err) => console.error("No se pudo enviar el push del memorandum:", err.message));

  return toListItem(created, { total: users.length, firmados: 0 });
};

// Los que recibio la persona (cualquier cargo): se ve el asunto pero no el contenido hasta dar el acuse o la firma.
export const listMemorandumsRecibidos = async (actor) => {
  const rows = await prisma.memorandumDestinatario.findMany({
    where: { userId: actor.id },
    include: { memorandum: { include: { emisor: EMISOR_SELECT } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((r) => toListItem(r.memorandum, { firmado: Boolean(r.firmadaAt), firmadoAt: r.firmadaAt }));
};

const emitidosWhere = (actor) => (isOffice(actor) ? {} : { emisorId: actor.id });

export const listMemorandumsEmitidos = async (actor) => {
  assertCanEmit(actor);
  const rows = await prisma.memorandum.findMany({
    where: emitidosWhere(actor),
    include: { emisor: EMISOR_SELECT, destinatarios: { select: { firmadaAt: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((m) =>
    toListItem(m, { total: m.destinatarios.length, firmados: m.destinatarios.filter((d) => d.firmadaAt).length })
  );
};

// Quien puede ver el seguimiento (y el documento) de un memorandum emitido: Admin y RRHH todos; un Responsable los suyos.
const loadEmitido = async (actor, id) => {
  assertCanEmit(actor);
  const memo = await prisma.memorandum.findUnique({
    where: { id },
    include: {
      emisor: EMISOR_SELECT,
      destinatarios: { include: { user: { select: USER_SELECT } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!memo || (!isOffice(actor) && memo.emisorId !== actor.id)) throw new AppError("Memorandum no encontrado", 404);
  return memo;
};

export const getMemorandumEmitidoForActor = async (actor, id) => {
  const memo = await loadEmitido(actor, id);
  const destinatarios = await Promise.all(
    memo.destinatarios.map(async (d) => ({
      id: d.id,
      userId: d.userId,
      nombre: fullName(d.user),
      cargo: d.user.cargo,
      firmado: Boolean(d.firmadaAt),
      firmadoAt: d.firmadaAt,
      firmaIp: d.firmaIp,
      firmaDispositivo: d.firmaDispositivo,
      firmaUrl: d.firmaKey ? await getSignedUrlForKey(d.firmaKey, FILE_URL_SECONDS) : null,
      avisos: d.avisos,
      ultimoAvisoAt: d.ultimoAvisoAt,
    }))
  );
  return {
    ...toListItem(memo, { total: destinatarios.length, firmados: destinatarios.filter((d) => d.firmado).length }),
    cuerpo: memo.cuerpo,
    huellaArchivo: memo.archivoHash,
    destinatarios,
  };
};

const loadOwn = async (actor, memorandumId) => {
  const row = await prisma.memorandumDestinatario.findUnique({
    where: { memorandumId_userId: { memorandumId, userId: actor.id } },
    include: { memorandum: true },
  });
  if (!row) throw new AppError("Memorandum no encontrado", 404);
  return row;
};

// El destinatario da su acuse (un toque) o su firma manuscrita, segun el nivel; solo despues puede abrirlo.
export const signMemorandumForActor = async (actor, id, body, meta) => {
  const row = await loadOwn(actor, id);
  if (row.firmadaAt) throw new AppError("Ya diste tu confirmacion de este memorandum", 409);

  let firmaKey = null;
  if (row.memorandum.nivelFirma === "FIRMA") {
    if (!body.firma) throw new AppError("Firma el memorandum para poder abrirlo", 400);
    const png = Buffer.from(body.firma.slice("data:image/png;base64,".length), "base64");
    if (png.length < 200 || png.subarray(1, 4).toString() !== "PNG") throw new AppError("La firma no es valida", 400);
    firmaKey = `memorandums/${row.memorandumId}/firmas/${actor.id}-${randomUUID()}.png`;
    await uploadObject(firmaKey, png, "image/png");
  }
  await prisma.memorandumDestinatario.update({
    where: { id: row.id },
    data: { firmadaAt: new Date(), firmaKey, firmaIp: clip(meta?.ip, 64), firmaDispositivo: clip(meta?.dispositivo, 300) },
  });
  forgetMemorandum(row.id);
  await log(id, actor.id, row.memorandum.nivelFirma === "FIRMA" ? "FIRMA" : "ENTENDIDO", meta);
  return { ok: true };
};

// URL temporal del PDF. El destinatario la obtiene solo despues de confirmar; quien lo emitio (y Admin/RRHH) siempre.
export const getMemorandumFileUrl = async (actor, id, meta) => {
  const own = await prisma.memorandumDestinatario.findUnique({
    where: { memorandumId_userId: { memorandumId: id, userId: actor.id } },
    include: { memorandum: { select: { archivoKey: true } } },
  });
  if (own) {
    if (!own.firmadaAt) throw new AppError("Confirma primero para poder abrir el memorandum", 403);
    await log(id, actor.id, "VISTA", meta);
    return { url: await getSignedUrlForKey(own.memorandum.archivoKey, FILE_URL_SECONDS), expiraEnSegundos: FILE_URL_SECONDS };
  }
  if (!canEmit(actor)) throw new AppError("Memorandum no encontrado", 404);
  const memo = await loadEmitido(actor, id);
  await log(id, actor.id, "VISTA_EMISOR", meta);
  return { url: await getSignedUrlForKey(memo.archivoKey, FILE_URL_SECONDS), expiraEnSegundos: FILE_URL_SECONDS };
};

const REMIND_GAP_MS = 30 * 60 * 1000;

// Push a mano a quienes todavia no confirmaron (no mas de uno cada 30 minutos por persona).
export const remindMemorandumForActor = async (actor, id, meta) => {
  const memo = await loadEmitido(actor, id);
  const now = Date.now();
  const pendientes = memo.destinatarios.filter((d) => !d.firmadaAt);
  const due = pendientes.filter((d) => !d.ultimoAvisoAt || now - d.ultimoAvisoAt.getTime() >= REMIND_GAP_MS);
  if (due.length > 0) {
    await sendPushToUserIds(
      due.map((d) => d.userId),
      {
        title: `Memorándum pendiente: ${memo.titulo}`,
        body: memo.nivelFirma === "FIRMA" ? "Está pendiente de tu firma." : "Está pendiente de que lo confirmes.",
        data: { type: "memorandum", id: memo.id },
      }
    ).catch((err) => console.error("No se pudo enviar el recordatorio del memorandum:", err.message));
    await prisma.memorandumDestinatario.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { ultimoAvisoAt: new Date(), avisos: { increment: 1 } } });
  }
  await log(id, actor.id, "RECORDATORIO", meta);
  return { pendientes: pendientes.length, avisados: due.length };
};

// Corregir una emision equivocada: solo mientras nadie lo haya firmado.
export const deleteMemorandumForActor = async (actor, id) => {
  const memo = await loadEmitido(actor, id);
  if (memo.destinatarios.some((d) => d.firmadaAt)) throw new AppError("Un memorandum que ya firmo alguien no se puede eliminar", 409);
  await deleteObject(memo.archivoKey);
  await prisma.memorandum.delete({ where: { id } });
  memo.destinatarios.forEach((d) => forgetMemorandum(d.id));
};

// Usado al eliminar un usuario: los memorandums se conservan, asi que si recibio o emitio alguno no se puede borrar.
export const hasMemorandums = async (userId) =>
  (await prisma.memorandumDestinatario.count({ where: { userId } })) + (await prisma.memorandum.count({ where: { emisorId: userId } })) > 0;
