import { randomUUID } from "node:crypto";
import {
  createDocument as createDocumentRecord,
  deleteDocumentById,
  findDocumentById,
  findDocuments,
  updateDocumentById,
} from "../models/document.model.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { findUserById, updateUserById } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";

// Admin y Responsables ven los documentos de todos; Recursos Humanos, solo los de los choferes.
const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN" || actor.cargo === "RRHH";

// Documentos personales que cada persona sube por su cuenta desde su perfil (choferes, Responsables y Admin). El resto de tipos (contrato,
// UNILAV, responsivas, permiso de trasporto, 13ma/14ma) son de la empresa: los carga y los gestiona solo la oficina.
export const SELF_DOCUMENT_TYPES = ["CARTA_IDENTITA", "PATENTE", "TRADUZIONE_PATENTE", "CODICE_FISCALE", "PASSAPORTO", "SOGGIORNO"];
const isSelfType = (tipo) => SELF_DOCUMENT_TYPES.includes(tipo);
// Quienes pueden subir sus propios documentos. Los usuarios cliente no entran (ni siquiera llegan aca, ver clienteGate) y Recursos Humanos tampoco por ahora.
const SELF_UPLOAD_CARGOS = ["CHOFER", "ADMIN", "OWNER"];

// Un Responsable (ADMIN) y Recursos Humanos gestionan los documentos de los choferes, no los de otros Admin o Responsables.
const assertChofer = async (usuarioId) => {
  const owner = await findUserById(usuarioId);
  if (owner?.cargo !== "CHOFER") throw new AppError("Solo puedes gestionar documentos de choferes", 403);
};

// write = crear, reemplazar o borrar. Ver el propio documento siempre se puede; modificarlo, solo si es uno de los personales.
const assertAccess = async (actor, document, { write = false } = {}) => {
  if (document.usuarioId === actor.id) {
    if (!write || actor.cargo === "OWNER" || (SELF_UPLOAD_CARGOS.includes(actor.cargo) && isSelfType(document.tipoDocumento))) return;
    throw new AppError("Este documento lo gestiona la oficina", 403);
  }
  if (actor.cargo === "OWNER") return;
  if (actor.cargo === "ADMIN" || actor.cargo === "RRHH") return assertChofer(document.usuarioId);
  throw new AppError("No tienes permisos para realizar esta accion", 403);
};

// PDFs se suben tal cual; las imagenes se comprimen y normalizan a webp con Sharp.
const processFile = async (file) => {
  if (file.mimetype === "application/pdf") {
    return { buffer: file.buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  const buffer = await compressImage(file.buffer);
  return { buffer, mimeType: "image/webp", ext: "webp" };
};

const buildStorageKey = (usuarioId, tipoDocumento, ext) =>
  `documentos/${usuarioId}/${tipoDocumento}-${Date.now()}-${randomUUID()}.${ext}`;

// El bucket es privado: la respuesta siempre lleva una URL firmada fresca, nunca la key interna.
const toResponse = async (document) => ({
  id: document.id,
  usuarioId: document.usuarioId,
  tipoDocumento: document.tipoDocumento,
  archivoUrl: await getSignedUrlForKey(document.archivoKey),
  mimeType: document.mimeType,
  fechaScadenza: document.fechaScadenza,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

export const createDocumentForUser = async (actor, file, data) => {
  if (!file) {
    throw new AppError("El archivo es obligatorio", 400);
  }

  // Sin usuarioId (o con el propio) es un documento personal: cada persona sube solo los suyos, de los 6 tipos personales.
  // La oficina (OWNER, ADMIN, RRHH) puede ademas cargar cualquier tipo a un chofer.
  let targetUsuarioId = actor.id;
  if (isPrivileged(actor) && data.usuarioId && data.usuarioId !== actor.id) {
    targetUsuarioId = data.usuarioId;
    if (actor.cargo !== "OWNER") await assertChofer(targetUsuarioId);
  } else {
    if (!SELF_UPLOAD_CARGOS.includes(actor.cargo)) throw new AppError("No tienes permisos para subir documentos propios", 403);
    if (actor.cargo !== "OWNER" && !isSelfType(data.tipoDocumento)) {
      throw new AppError("Ese documento lo carga la oficina", 403);
    }
  }

  const { buffer, mimeType, ext } = await processFile(file);
  const archivoKey = buildStorageKey(targetUsuarioId, data.tipoDocumento, ext);

  await uploadObject(archivoKey, buffer, mimeType);

  const document = await createDocumentRecord({
    usuarioId: targetUsuarioId,
    tipoDocumento: data.tipoDocumento,
    archivoKey,
    mimeType,
    fechaScadenza: data.fechaScadenza,
  });

  // Si lo tenia marcado como "no tengo", ya no: acaba de subirlo.
  const owner = await findUserById(targetUsuarioId);
  if (owner?.documentosNoTiene?.includes(data.tipoDocumento)) {
    await updateUserById(targetUsuarioId, { documentosNoTiene: owner.documentosNoTiene.filter((t) => t !== data.tipoDocumento) });
  }

  return toResponse(document);
};

export const listDocumentsForActor = async (actor, queryUsuarioId) => {
  const usuarioId = isPrivileged(actor) ? queryUsuarioId : actor.id;
  if ((actor.cargo === "RRHH" || actor.cargo === "ADMIN") && usuarioId && usuarioId !== actor.id) await assertChofer(usuarioId);
  const documents = await findDocuments(usuarioId, { soloChoferes: actor.cargo === "RRHH" });
  return Promise.all(documents.map(toResponse));
};

export const getDocumentByIdForActor = async (actor, id) => {
  const document = await findDocumentById(id);
  if (!document) {
    throw new AppError("Documento no encontrado", 404);
  }
  await assertAccess(actor, document);
  return toResponse(document);
};

export const updateDocumentForActor = async (actor, id, data, file) => {
  const document = await findDocumentById(id);
  if (!document) {
    throw new AppError("Documento no encontrado", 404);
  }
  await assertAccess(actor, document, { write: true });
  // Nadie puede cambiar el tipo de su propio documento a uno de la empresa (por ejemplo, hacer pasar un archivo suyo por un "contrato").
  if (data.tipoDocumento && document.usuarioId === actor.id && actor.cargo !== "OWNER" && !isSelfType(data.tipoDocumento)) {
    throw new AppError("Ese documento lo carga la oficina", 403);
  }

  const payload = { ...data };

  if (file) {
    const { buffer, mimeType, ext } = await processFile(file);
    const newKey = buildStorageKey(document.usuarioId, data.tipoDocumento ?? document.tipoDocumento, ext);
    await uploadObject(newKey, buffer, mimeType);
    await deleteObject(document.archivoKey);
    payload.archivoKey = newKey;
    payload.mimeType = mimeType;
  }

  const updated = await updateDocumentById(id, payload);
  return toResponse(updated);
};

export const deleteDocumentForActor = async (actor, id) => {
  const document = await findDocumentById(id);
  if (!document) {
    throw new AppError("Documento no encontrado", 404);
  }
  await assertAccess(actor, document, { write: true });

  await deleteObject(document.archivoKey);
  await deleteDocumentById(id);
};

// Usado por user.service.js antes de borrar un usuario, para no dejar archivos huerfanos en R2.
export const purgeDocumentsForUser = async (usuarioId) => {
  const documents = await findDocuments(usuarioId);
  await Promise.all(documents.map((document) => deleteObject(document.archivoKey)));
};
