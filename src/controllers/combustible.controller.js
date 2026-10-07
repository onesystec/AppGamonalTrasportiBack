import {
  createCombustibleForActor,
  deleteCombustibleForActor,
  getCombustibleForActor,
  getCombustibleStatsForActor,
  getCombustibleSummaryForActor,
  listCombustibleForActor,
  listCombustibleCandidatesForActor,
  listMetodos,
  rematchCombustiblesForActor,
  updateCombustibleForActor,
} from "../services/combustible.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const registro = await createCombustibleForActor(req.user, req.body, req.files);
  res.status(201).json({ success: true, data: { registro } });
});

export const list = asyncHandler(async (req, res) => {
  const result = await listCombustibleForActor(req.user, req.query);
  res.status(200).json({ success: true, data: result });
});

export const summary = asyncHandler(async (req, res) => {
  const result = await getCombustibleSummaryForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { summary: result } });
});

export const stats = asyncHandler(async (req, res) => {
  const result = await getCombustibleStatsForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { stats: result } });
});

export const metodos = asyncHandler(async (req, res) => {
  const result = await listMetodos();
  res.status(200).json({ success: true, data: { metodos: result } });
});

export const getById = asyncHandler(async (req, res) => {
  const registro = await getCombustibleForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { registro } });
});

export const update = asyncHandler(async (req, res) => {
  const registro = await updateCombustibleForActor(req.user, req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { registro } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteCombustibleForActor(req.user, req.params.id);
  res.status(204).send();
});

export const candidates = asyncHandler(async (req, res) => {
  const items = await listCombustibleCandidatesForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { candidatos: items } });
});

export const rematch = asyncHandler(async (req, res) => {
  const result = await rematchCombustiblesForActor(req.user);
  res.status(200).json({ success: true, data: { resultado: result } });
});
