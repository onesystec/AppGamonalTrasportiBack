import {
  createMancatoForActor,
  deleteMancatoForActor,
  getMancatoForActor,
  getMancatoStatsForActor,
  getMancatoSummaryForActor,
  listMancatosForActor,
  updateMancatoForActor,
} from "../services/mancato.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const mancato = await createMancatoForActor(req.user, req.body, req.files);
  res.status(201).json({ success: true, data: { mancato } });
});

export const list = asyncHandler(async (req, res) => {
  const result = await listMancatosForActor(req.user, req.query);
  res.status(200).json({ success: true, data: result });
});

export const summary = asyncHandler(async (req, res) => {
  const result = await getMancatoSummaryForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { summary: result } });
});

export const getById = asyncHandler(async (req, res) => {
  const mancato = await getMancatoForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { mancato } });
});

export const update = asyncHandler(async (req, res) => {
  const mancato = await updateMancatoForActor(req.user, req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { mancato } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteMancatoForActor(req.user, req.params.id);
  res.status(204).send();
});

export const stats = asyncHandler(async (req, res) => {
  const result = await getMancatoStatsForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { stats: result } });
});
