import {
  createDocumentForUser,
  deleteDocumentForActor,
  getDocumentByIdForActor,
  listDocumentsForActor,
  listPersonalParaDocumentos,
  updateDocumentForActor,
} from "../services/document.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const document = await createDocumentForUser(req.user, req.file, req.body);
  res.status(201).json({ success: true, data: { document } });
});

export const list = asyncHandler(async (req, res) => {
  const documents = await listDocumentsForActor(req.user, req.query.usuarioId);
  res.status(200).json({ success: true, data: { documents } });
});

export const getById = asyncHandler(async (req, res) => {
  const document = await getDocumentByIdForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { document } });
});

export const update = asyncHandler(async (req, res) => {
  const document = await updateDocumentForActor(req.user, req.params.id, req.body, req.file);
  res.status(200).json({ success: true, data: { document } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteDocumentForActor(req.user, req.params.id);
  res.status(204).send();
});

export const listPersonal = asyncHandler(async (_req, res) => {
  const personal = await listPersonalParaDocumentos();
  res.status(200).json({ success: true, data: { personal } });
});
