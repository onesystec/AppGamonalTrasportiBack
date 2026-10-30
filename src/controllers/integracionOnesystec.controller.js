import { listChoferes, listUsos } from "../services/integracionOnesystec.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const choferes = asyncHandler(async (_req, res) => {
  res.status(200).json({ success: true, data: { choferes: await listChoferes() } });
});

export const usos = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { usos: await listUsos(req.query) } });
});
