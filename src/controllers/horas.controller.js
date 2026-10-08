import {
  listHoursForReviewForActor,
  recalcEstimacionForActor,
  recalcParadasForActor,
  setReceptionTimeForActor,
  reviewHoursForActor,
  submitHoursForActor,
} from "../services/horas.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const submit = asyncHandler(async (req, res) => {
  const result = await submitHoursForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: result });
});

export const review = asyncHandler(async (req, res) => {
  const result = await reviewHoursForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: result });
});

export const pendientes = asyncHandler(async (req, res) => {
  const items = await listHoursForReviewForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { items } });
});

export const recalcParadas = asyncHandler(async (req, res) => {
  const result = await recalcParadasForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const reception = asyncHandler(async (req, res) => {
  const result = await setReceptionTimeForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: result });
});

export const recalcEstimacion = asyncHandler(async (req, res) => {
  const result = await recalcEstimacionForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});
