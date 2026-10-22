import {
  deleteMemorandumForActor,
  emitMemorandumForActor,
  getEmitOptionsForActor,
  getMemorandumEmitidoForActor,
  getMemorandumFileUrl,
  listMemorandumsEmitidos,
  listMemorandumsRecibidos,
  remindMemorandumForActor,
  signMemorandumForActor,
} from "../services/memorandum.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// IP real (detras de Cloudflare/Render) y dispositivo, para dejarlos en el comprobante.
const requestMeta = (req) => ({
  ip: req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? req.ip,
  dispositivo: req.headers["user-agent"],
});

export const mine = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { memorandums: await listMemorandumsRecibidos(req.user) } });
});

export const options = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await getEmitOptionsForActor(req.user) });
});

export const emitted = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { memorandums: await listMemorandumsEmitidos(req.user) } });
});

export const emittedDetail = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { memorandum: await getMemorandumEmitidoForActor(req.user, req.params.id) } });
});

export const emit = asyncHandler(async (req, res) => {
  const memorandum = await emitMemorandumForActor(req.user, req.body, requestMeta(req));
  res.status(201).json({ success: true, data: { memorandum } });
});

export const sign = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await signMemorandumForActor(req.user, req.params.id, req.body, requestMeta(req)) });
});

export const fileUrl = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await getMemorandumFileUrl(req.user, req.params.id, requestMeta(req)) });
});

export const remind = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await remindMemorandumForActor(req.user, req.params.id, requestMeta(req)) });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteMemorandumForActor(req.user, req.params.id);
  res.status(204).send();
});
