import { getParadasStatus, listParadasForActor } from "../services/vehicleStops.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const list = asyncHandler(async (req, res) => {
  const data = await listParadasForActor(req.user, req.query);
  res.status(200).json({ success: true, data });
});

export const status = asyncHandler(async (_req, res) => {
  res.status(200).json({ success: true, data: { estado: getParadasStatus() } });
});
