import {
  createOtroGastoForActor,
  deleteOtroGastoForActor,
  listOtrosGastosForActor,
  reviewOtroGastoForActor,
  updateOtroGastoForActor,
} from "../services/otroGasto.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const comprobanteOf = (req) => req.files?.comprobante?.[0] ?? null;

export const list = asyncHandler(async (req, res) => {
  const result = await listOtrosGastosForActor(req.user, req.query);
  res.status(200).json({ success: true, data: result });
});

export const create = asyncHandler(async (req, res) => {
  const gasto = await createOtroGastoForActor(req.user, req.body, comprobanteOf(req));
  res.status(201).json({ success: true, data: { gasto } });
});

export const update = asyncHandler(async (req, res) => {
  const gasto = await updateOtroGastoForActor(req.user, req.params.id, req.body, comprobanteOf(req));
  res.status(200).json({ success: true, data: { gasto } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteOtroGastoForActor(req.user, req.params.id);
  res.status(204).send();
});

export const review = asyncHandler(async (req, res) => {
  const gasto = await reviewOtroGastoForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: { gasto } });
});
