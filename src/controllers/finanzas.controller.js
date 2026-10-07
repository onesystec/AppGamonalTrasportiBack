import {
  getFinanzasResumenForActor,
  getGastosServiciosForActor,
  getPagosChoferesForActor,
} from "../services/finanzas.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const resumen = asyncHandler(async (req, res) => {
  const result = await getFinanzasResumenForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { resumen: result } });
});

export const pagos = asyncHandler(async (req, res) => {
  const result = await getPagosChoferesForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { pagos: result } });
});

export const gastosServicios = asyncHandler(async (req, res) => {
  const result = await getGastosServiciosForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { gastos: result } });
});
