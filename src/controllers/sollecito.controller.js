import {
  createSollecito,
  deleteSollecito,
  getSollecito,
  listSolleciti,
  updateSollecito,
} from "../services/sollecito.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const list = asyncHandler(async (req, res) => {
  const result = await listSolleciti(req.query);
  res.status(200).json({ success: true, data: result });
});

export const getById = asyncHandler(async (req, res) => {
  const sollecito = await getSollecito(req.params.id);
  res.status(200).json({ success: true, data: { sollecito } });
});

export const create = asyncHandler(async (req, res) => {
  const sollecito = await createSollecito(req.user, req.body, req.files);
  res.status(201).json({ success: true, data: { sollecito } });
});

export const update = asyncHandler(async (req, res) => {
  const sollecito = await updateSollecito(req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { sollecito } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteSollecito(req.params.id);
  res.status(204).send();
});
