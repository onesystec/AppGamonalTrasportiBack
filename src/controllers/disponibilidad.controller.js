import { getDisponibilidadForActor } from "../services/disponibilidad.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const disponibilidad = asyncHandler(async (req, res) => {
  const result = await getDisponibilidadForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { disponibilidad: result } });
});
