import {
  createTrabajoAdicionalForActor,
  deleteTrabajoAdicionalForActor,
  listTrabajosAdicionalesForActor,
  reviewTrabajoAdicionalForActor,
  updateTrabajoAdicionalForActor,
} from "../services/trabajoAdicional.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const trabajo = await createTrabajoAdicionalForActor(req.user, req.body, req.file);
  res.status(201).json({ success: true, data: { trabajo } });
});
export const list = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await listTrabajosAdicionalesForActor(req.user, req.query) });
});
export const update = asyncHandler(async (req, res) => {
  const trabajo = await updateTrabajoAdicionalForActor(req.user, req.params.id, req.body, req.file);
  res.status(200).json({ success: true, data: { trabajo } });
});
export const remove = asyncHandler(async (req, res) => {
  await deleteTrabajoAdicionalForActor(req.user, req.params.id);
  res.status(204).send();
});
export const review = asyncHandler(async (req, res) => {
  const trabajo = await reviewTrabajoAdicionalForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: { trabajo } });
});
