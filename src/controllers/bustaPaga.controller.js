import {
  deleteBustaPagaForActor,
  listDestinatariosForActor,
  getBustaPagaFileUrl,
  getConstanciaForActor,
  listBustasPagaForActor,
  signBustaPagaForActor,
  uploadBustaPagaForActor,
} from "../services/bustaPaga.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// IP real (detras de Cloudflare/Render) y dispositivo, para dejarlos en el comprobante de firma.
const requestMeta = (req) => ({
  ip: req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? req.ip,
  dispositivo: req.headers["user-agent"],
});

export const list = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { bustas: await listBustasPagaForActor(req.user, req.query) } });
});

export const destinatarios = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { usuarios: await listDestinatariosForActor(req.user) } });
});

export const upload = asyncHandler(async (req, res) => {
  const busta = await uploadBustaPagaForActor(req.user, req.file, req.body, requestMeta(req));
  res.status(201).json({ success: true, data: { busta } });
});

export const sign = asyncHandler(async (req, res) => {
  const busta = await signBustaPagaForActor(req.user, req.params.id, req.body, requestMeta(req));
  res.status(200).json({ success: true, data: { busta } });
});

export const fileUrl = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await getBustaPagaFileUrl(req.user, req.params.id, requestMeta(req)) });
});

export const constancia = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { constancia: await getConstanciaForActor(req.user, req.params.id) } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteBustaPagaForActor(req.user, req.params.id);
  res.status(204).send();
});
