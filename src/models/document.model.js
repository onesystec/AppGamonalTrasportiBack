import { prisma } from "../config/prisma.js";

export const createDocument = (data) => prisma.documento.create({ data });

export const findDocumentById = (id) => prisma.documento.findUnique({ where: { id } });

export const findDocuments = (usuarioId, { soloChoferes = false } = {}) =>
  prisma.documento.findMany({
    where: { ...(usuarioId ? { usuarioId } : {}), ...(soloChoferes ? { usuario: { cargo: "CHOFER" } } : {}) },
    orderBy: { createdAt: "desc" },
  });

export const updateDocumentById = (id, data) =>
  prisma.documento.update({ where: { id }, data });

export const deleteDocumentById = (id) => prisma.documento.delete({ where: { id } });
