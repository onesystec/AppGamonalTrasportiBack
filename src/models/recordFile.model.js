import { prisma } from "../config/prisma.js";

export const createRecordFile = (data) => prisma.recordFile.create({ data });

export const findRecordFileById = (id) => prisma.recordFile.findUnique({ where: { id } });

export const findRecordFilesByRecordId = (recordId) =>
  prisma.recordFile.findMany({ where: { recordId }, orderBy: { createdAt: "desc" } });

export const deleteRecordFileById = (id) => prisma.recordFile.delete({ where: { id } });

// Retencion de fotos de servicio (ver cleanupExpiredRecordFiles): archivos subidos antes
// de cutoffDate, de los tipos indicados. excludeIds evita reintentar en el mismo run los
// que fallaron al borrarse en R2.
const expiredWhere = ({ cutoffDate, tipos, excludeIds = [] }) => ({
  createdAt: { lt: cutoffDate },
  tipoArchivo: { in: tipos },
  ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
});

export const countExpiredRecordFiles = (filters) =>
  prisma.recordFile.count({ where: expiredWhere(filters) });

export const findExpiredRecordFiles = (filters, take) =>
  prisma.recordFile.findMany({
    where: expiredWhere(filters),
    select: { id: true, archivoKey: true },
    orderBy: { createdAt: "asc" },
    take,
  });

export const deleteRecordFilesByIds = (ids) =>
  prisma.recordFile.deleteMany({ where: { id: { in: ids } } });
