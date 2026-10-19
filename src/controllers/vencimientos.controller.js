import { getVencimientosForActor } from "../services/vencimientos.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const listar = asyncHandler(async (req, res) => {
  const result = await getVencimientosForActor(req.user);
  res.status(200).json({ success: true, data: { vencimientos: result } });
});
