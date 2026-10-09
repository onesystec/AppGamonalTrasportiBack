import { createHash, randomUUID } from "node:crypto";
import {
  countBustasDeChofer,
  createBustaPaga,
  deleteBustaPaga,
  findAccesos,
  findBustaPagaById,
  findBustaPagaDeChoferMes,
  findBustasPaga,
  logAcceso,
  updateBustaPaga,
} from "../models/bustaPaga.model.js";
import { findUserById } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";

// Quien carga y gestiona las busta paga: Recursos Humanos (y el Admin). Los Responsables no las ven.
const canManage = (actor) => actor.cargo === "RRHH" || actor.cargo === "OWNER";

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const FILE_URL_SECONDS = 120;

const assertManager = (actor) => {
  if (!canManage(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
};

const clip = (value, max) => (value ? String(value).slice(0, max) : null);
const log = (bustaPagaId, usuarioId, accion, meta) =>
  logAcceso({ bustaPagaId, usuarioId, accion, ip: clip(meta?.ip, 64), dispositivo: clip(meta?.dispositivo, 300) });

const toListItem = (b) => ({
  id: b.id,
  choferId: b.choferId,
  chofer: b.chofer ? `${b.chofer.nombre} ${b.chofer.apellido}` : null,
  anio: b.anio,
  mes: b.mes,
  nombreArchivo: b.nombreArchivo,
  subidaAt: b.createdAt,
  firmada: Boolean(b.firmadaAt),
  firmadaAt: b.firmadaAt,
});

export const listBustasPagaForActor = async (actor, query) => {
  if (actor.cargo === "CHOFER") {
    const rows = await findBustasPaga({ choferId: actor.id, anio: query.anio });
    return rows.map(toListItem);
  }
  assertManager(actor);
  const rows = await findBustasPaga(query);
  return rows.map(toListItem);
};

export const uploadBustaPagaForActor = async (actor, file, body, meta) => {
  assertManager(actor);
  if (!file) throw new AppError("Selecciona el archivo PDF de la busta paga", 400);
  if (file.buffer.subarray(0, 4).toString() !== "%PDF") throw new AppError("El archivo no es un PDF valido", 400);

  const chofer = await findUserById(body.choferId);
  if (!chofer || chofer.cargo !== "CHOFER") throw new AppError("Chofer no encontrado", 404);

  const existing = await findBustaPagaDeChoferMes(body.choferId, body.anio, body.mes);
  if (existing?.firmadaAt) {
    throw new AppError(
      `La busta paga de ${MONTHS[body.mes - 1]} ${body.anio} de este chofer ya fue firmada y no se puede reemplazar`,
      409
    );
  }

  const archivoKey = `busta-paga/${body.choferId}/${body.anio}-${String(body.mes).padStart(2, "0")}-${randomUUID()}.pdf`;
  await uploadObject(archivoKey, file.buffer, "application/pdf");
  const archivoHash = createHash("sha256").update(file.buffer).digest("hex");
  const data = {
    archivoKey,
    archivoHash,
    nombreArchivo: clip(file.originalname, 200),
    subidaPorId: actor.id,
  };

  let record;
  if (existing) {
    record = await updateBustaPaga(existing.id, data);
    await deleteObject(existing.archivoKey);
    await log(record.id, actor.id, "REEMPLAZO", meta);
  } else {
    record = await createBustaPaga({ choferId: body.choferId, anio: body.anio, mes: body.mes, ...data });
    await log(record.id, actor.id, "SUBIDA", meta);
  }

  // Aviso al chofer, sin ningun dato del importe.
  sendPushToUserIds([body.choferId], {
    title: "Tu busta paga esta disponible",
    body: `Ya puedes ver tu busta paga de ${MONTHS[body.mes - 1]} ${body.anio}.`,
    data: { type: "busta-paga", id: record.id },
  }).catch(() => {});

  return toListItem({ ...record, chofer });
};

const loadOwn = async (actor, id) => {
  const record = await findBustaPagaById(id);
  if (!record || record.choferId !== actor.id) throw new AppError("Busta paga no encontrada", 404);
  return record;
};

// El chofer firma a mano que la recibe: se guarda el trazo, la hora del servidor, la IP, el dispositivo
// y la huella del archivo. Solo despues puede abrirla.
export const signBustaPagaForActor = async (actor, id, body, meta) => {
  if (actor.cargo !== "CHOFER") throw new AppError("Solo el chofer puede firmar su busta paga", 403);
  const record = await loadOwn(actor, id);
  if (record.firmadaAt) throw new AppError("Esta busta paga ya fue firmada", 409);

  const png = Buffer.from(body.firma.slice("data:image/png;base64,".length), "base64");
  if (png.length < 200 || png.subarray(1, 4).toString() !== "PNG") throw new AppError("La firma no es valida", 400);

  const firmaKey = `busta-paga/${actor.id}/firmas/${record.id}-${randomUUID()}.png`;
  await uploadObject(firmaKey, png, "image/png");
  const updated = await updateBustaPaga(record.id, {
    firmadaAt: new Date(),
    firmaKey,
    firmaIp: clip(meta?.ip, 64),
    firmaDispositivo: clip(meta?.dispositivo, 300),
  });
  await log(record.id, actor.id, "FIRMA", meta);
  return toListItem(updated);
};

// URL temporal del PDF. El chofer solo la obtiene despues de firmar; Recursos Humanos siempre.
export const getBustaPagaFileUrl = async (actor, id, meta) => {
  let record;
  if (actor.cargo === "CHOFER") {
    record = await loadOwn(actor, id);
    if (!record.firmadaAt) throw new AppError("Firma primero para poder ver tu busta paga", 403);
  } else {
    assertManager(actor);
    record = await findBustaPagaById(id);
    if (!record) throw new AppError("Busta paga no encontrada", 404);
  }
  await log(record.id, actor.id, actor.cargo === "CHOFER" ? "VISTA" : "VISTA_RRHH", meta);
  return { url: await getSignedUrlForKey(record.archivoKey, FILE_URL_SECONDS), expiraEnSegundos: FILE_URL_SECONDS };
};

// Comprobante de recepcion para Recursos Humanos: quien, cuando, desde que dispositivo y la firma.
export const getConstanciaForActor = async (actor, id) => {
  assertManager(actor);
  const record = await findBustaPagaById(id);
  if (!record) throw new AppError("Busta paga no encontrada", 404);
  if (!record.firmadaAt) throw new AppError("El chofer todavia no firmo esta busta paga", 409);
  const [chofer, subidaPor, accesos] = await Promise.all([
    findUserById(record.choferId),
    findUserById(record.subidaPorId),
    findAccesos(record.id),
  ]);
  return {
    id: record.id,
    chofer: chofer ? `${chofer.nombre} ${chofer.apellido}` : null,
    periodo: `${MONTHS[record.mes - 1]} ${record.anio}`,
    anio: record.anio,
    mes: record.mes,
    nombreArchivo: record.nombreArchivo,
    huellaArchivo: record.archivoHash,
    subidaAt: record.createdAt,
    subidaPor: subidaPor ? `${subidaPor.nombre} ${subidaPor.apellido}` : null,
    firmadaAt: record.firmadaAt,
    firmaIp: record.firmaIp,
    firmaDispositivo: record.firmaDispositivo,
    firmaUrl: record.firmaKey ? await getSignedUrlForKey(record.firmaKey, FILE_URL_SECONDS) : null,
    accesos: accesos.map((a) => ({ accion: a.accion, createdAt: a.createdAt, ip: a.ip })),
  };
};

// Corregir una subida equivocada: solo mientras el chofer no la haya firmado.
export const deleteBustaPagaForActor = async (actor, id) => {
  assertManager(actor);
  const record = await findBustaPagaById(id);
  if (!record) throw new AppError("Busta paga no encontrada", 404);
  if (record.firmadaAt) throw new AppError("Una busta paga firmada no se puede eliminar", 409);
  await deleteObject(record.archivoKey);
  await deleteBustaPaga(id);
};

// Usado al eliminar un chofer: las busta paga se conservan, asi que si tiene no se puede borrar.
export const hasBustasPaga = async (choferId) => (await countBustasDeChofer(choferId)) > 0;
