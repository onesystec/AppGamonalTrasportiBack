import { randomUUID } from "node:crypto";
import { findRecordById } from "../models/record.model.js";
import {
  countExpiredRecordFiles,
  createRecordFile as createRecordFileModel,
  deleteRecordFileById,
  deleteRecordFilesByIds,
  findExpiredRecordFiles,
  findRecordFileById,
  findRecordFilesByRecordId,
} from "../models/recordFile.model.js";
import { env } from "../config/env.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { AppError } from "../utils/AppError.js";

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const assertRecordAccess = (actor, record) => {
  if (isPrivileged(actor) || record.driverId === actor.id) return;
  throw new AppError("No tienes permisos para realizar esta accion", 403);
};

// Mismo criterio de procesamiento que document.service.js: PDFs tal cual, imagenes comprimidas con Sharp.
const processFile = async (file) => {
  if (file.mimetype === "application/pdf") {
    return { buffer: file.buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  const buffer = await compressImage(file.buffer);
  return { buffer, mimeType: "image/webp", ext: "webp" };
};

const buildStorageKey = (recordId, tipoArchivo, ext) =>
  `records/${recordId}/${tipoArchivo}-${Date.now()}-${randomUUID()}.${ext}`;

const toResponse = async (file) => ({
  id: file.id,
  recordId: file.recordId,
  tipoArchivo: file.tipoArchivo,
  archivoUrl: await getSignedUrlForKey(file.archivoKey),
  createdAt: file.createdAt,
});

export const createFileForRecord = async (actor, recordId, tipoArchivo, file) => {
  const record = await findRecordById(recordId);
  if (!record) {
    throw new AppError("Registro no encontrado", 404);
  }
  assertRecordAccess(actor, record);

  if (!isPrivileged(actor) && tipoArchivo !== "FOTO_ENTREGA") {
    throw new AppError("Un chofer solo puede subir archivos de tipo FOTO_ENTREGA", 403);
  }

  if (!file) {
    throw new AppError("El archivo es obligatorio", 400);
  }

  const { buffer, mimeType, ext } = await processFile(file);
  const archivoKey = buildStorageKey(recordId, tipoArchivo, ext);
  await uploadObject(archivoKey, buffer, mimeType);

  const recordFile = await createRecordFileModel({ recordId, tipoArchivo, archivoKey });
  return toResponse(recordFile);
};

export const listFilesForRecord = async (actor, recordId) => {
  const record = await findRecordById(recordId);
  if (!record) {
    throw new AppError("Registro no encontrado", 404);
  }
  assertRecordAccess(actor, record);

  const files = await findRecordFilesByRecordId(recordId);
  return Promise.all(files.map(toResponse));
};

export const deleteFile = async (id) => {
  const file = await findRecordFileById(id);
  if (!file) {
    throw new AppError("Archivo no encontrado", 404);
  }

  await deleteObject(file.archivoKey);
  await deleteRecordFileById(id);
};

// Usado por record.service.js antes de borrar un record, para no dejar archivos huerfanos en R2.
export const purgeFilesForRecord = async (recordId) => {
  const files = await findRecordFilesByRecordId(recordId);
  await Promise.all(files.map((file) => deleteObject(file.archivoKey)));
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const CLEANUP_MAX_BATCHES = 20;
const CLEANUP_DELETE_CONCURRENCY = 10;

// Borra las fotos de comprobante vencidas (mas viejas que RECORD_FILE_RETENTION_DAYS,
// contadas desde que se subieron) para liberar storage en R2. Primero el objeto en R2 y
// despues la fila: si el borrado en R2 falla, la fila se conserva y se reintenta en la
// proxima corrida (borrar una key que ya no existe en R2 no da error). Acotado por
// corrida (CLEANUP_BATCH_SIZE x CLEANUP_MAX_BATCHES) para no tardar de mas si hay mucho
// atrasado; lo que quede se borra en la siguiente. dryRun solo cuenta, no borra nada.
export const cleanupExpiredRecordFiles = async ({ dryRun = false } = {}) => {
  const retentionDays = env.RECORD_FILE_RETENTION_DAYS;
  const tipos = env.RECORD_FILE_RETENTION_TYPES;
  const cutoffDate = new Date(Date.now() - retentionDays * DAY_MS);
  const base = { retentionDays, tipos, cutoffDate };

  if (!(retentionDays > 0) || tipos.length === 0) {
    return { ...base, enabled: false, deletedCount: 0, failedCount: 0 };
  }

  if (dryRun) {
    const expiredCount = await countExpiredRecordFiles({ cutoffDate, tipos });
    return { ...base, enabled: true, dryRun: true, expiredCount };
  }

  let deletedCount = 0;
  const failedIds = [];

  for (let batchIndex = 0; batchIndex < CLEANUP_MAX_BATCHES; batchIndex += 1) {
    const batch = await findExpiredRecordFiles(
      { cutoffDate, tipos, excludeIds: failedIds },
      CLEANUP_BATCH_SIZE
    );
    if (batch.length === 0) break;

    const deletedIds = [];
    for (let i = 0; i < batch.length; i += CLEANUP_DELETE_CONCURRENCY) {
      const chunk = batch.slice(i, i + CLEANUP_DELETE_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((file) => deleteObject(file.archivoKey)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          deletedIds.push(chunk[index].id);
        } else {
          failedIds.push(chunk[index].id);
          console.error(`No se pudo borrar ${chunk[index].archivoKey} de R2:`, result.reason?.message);
        }
      });
    }

    if (deletedIds.length > 0) {
      await deleteRecordFilesByIds(deletedIds);
      deletedCount += deletedIds.length;
    }
  }

  return { ...base, enabled: true, deletedCount, failedCount: failedIds.length };
};
