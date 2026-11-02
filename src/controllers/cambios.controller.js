import { historialCambiosServicio, listAlertasCambio, marcarAlertasLeidas } from "../services/cambioCelda.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Oficina (Owner y Admin): alertas de servicios entregados que un cliente edito, y el historial de cambios de un servicio.
export const listar = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.query.recordId) return res.status(200).json({ success: true, data: { items: await historialCambiosServicio(req.user, req.query.recordId) } });
  return res.status(200).json({ success: true, data: await listAlertasCambio(req.user) });
});

export const leer = asyncHandler(async (req, res) => {
  await marcarAlertasLeidas(req.user, req.body.ids);
  res.status(200).json({ success: true, data: null });
});
