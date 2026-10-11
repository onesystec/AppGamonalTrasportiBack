import {
  createMultaForActor,
  deleteMultaForActor,
  getMultaAlertsForActor,
  getMultaForActor,
  getMultaStatsForActor,
  getMultaSummaryForActor,
  listMultasForActor,
  suggestDriversForActor,
  updateMultaForActor,
  uploadMyComprobanteForActor,
} from "../services/multa.service.js";
import { suggestDriverForMultaForActor, suggestDriversForMultasForActor } from "../services/multaSugerencia.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const multa = await createMultaForActor(req.user, req.body, req.files);
  res.status(201).json({ success: true, data: { multa } });
});

export const list = asyncHandler(async (req, res) => {
  const result = await listMultasForActor(req.user, req.query);
  res.status(200).json({ success: true, data: result });
});

export const summary = asyncHandler(async (req, res) => {
  const result = await getMultaSummaryForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { summary: result } });
});

export const stats = asyncHandler(async (req, res) => {
  const result = await getMultaStatsForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { stats: result } });
});

export const getById = asyncHandler(async (req, res) => {
  const multa = await getMultaForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { multa } });
});

export const update = asyncHandler(async (req, res) => {
  const multa = await updateMultaForActor(req.user, req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { multa } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteMultaForActor(req.user, req.params.id);
  res.status(204).send();
});

export const alerts = asyncHandler(async (req, res) => {
  const result = await getMultaAlertsForActor(req.user);
  res.status(200).json({ success: true, data: { alerts: result } });
});

export const suggestDriver = asyncHandler(async (req, res) => {
  const result = await suggestDriversForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { sugerencia: result } });
});

export const uploadMyComprobante = asyncHandler(async (req, res) => {
  const multa = await uploadMyComprobanteForActor(req.user, req.params.id, req.file);
  res.status(200).json({ success: true, data: { multa } });
});

// Quien pudo ser el responsable de una multa sin chofer (solo sugiere; la oficina decide).
export const suggestForMulta = asyncHandler(async (req, res) => {
  const sugerencia = await suggestDriverForMultaForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { sugerencia } });
});

export const suggestForMultas = asyncHandler(async (req, res) => {
  const sugerencias = await suggestDriversForMultasForActor(req.user, req.query.ids);
  res.status(200).json({ success: true, data: { sugerencias } });
});
