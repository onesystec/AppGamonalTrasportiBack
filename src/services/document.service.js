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
import { findUserById } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";

// Admin y Responsables ven los documentos de todos; Recursos Humanos, solo los de los choferes.
const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN" || actor.cargo === "RRHH";

const assertChofer = async (usuarioId) => {
  const owner = await findUserById(usuarioId);
  if (owner?.cargo !== "CHOFER") throw new AppError("Recursos Humanos solo gestiona documentos de choferes", 403);
};

const assertAccess = async (actor, document) => {
  if (document.usuarioId === actor.id) return;
  if (actor.cargo === "OWNER" || actor.cargo === "ADMIN") return;
  if (actor.cargo === "RRHH") return assertChofer(document.usuarioId);
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

  let targetUsuarioId = actor.id;
  if (isPrivileged(actor)) {
    if (!data.usuarioId) {
      throw new AppError("usuarioId es obligatorio para OWNER/ADMIN", 400);
    }
    targetUsuarioId = data.usuarioId;
    if (actor.cargo === "RRHH") await assertChofer(targetUsuarioId);
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

  return toResponse(document);
};

export const listDocumentsForActor = async (actor, queryUsuarioId) => {
  const usuarioId = isPrivileged(actor) ? queryUsuarioId : actor.id;
  if (actor.cargo === "RRHH" && usuarioId) await assertChofer(usuarioId);
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
  await assertAccess(actor, document);

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
  await assertAccess(actor, document);

  await deleteObject(document.archivoKey);
  await deleteDocumentById(id);
};

// Usado por user.service.js antes de borrar un usuario, para no dejar archivos huerfanos en R2.
export const purgeDocumentsForUser = async (usuarioId) => {
  const documents = await findDocuments(usuarioId);
  await Promise.all(documents.map((document) => deleteObject(document.archivoKey)));
};
