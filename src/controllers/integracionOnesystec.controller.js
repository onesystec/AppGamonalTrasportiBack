import { listChoferes, listUsos } from "../services/integracionOnesystec.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { resumenDiario as buildResumenDiario } from "../services/informeDiario.service.js";

export const choferes = asyncHandler(async (_req, res) => {
  res.status(200).json({ success: true, data: { choferes: await listChoferes() } });
});

export const usos = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { usos: await listUsos(req.query) } });
});

// Vencimientos de hoy y manana (multas, datos del conductor y mancatos) para la Oficina Virtual. Solo lectura.
export const resumenDiario = asyncHandler(async (_req, res) => {
  res.status(200).json({ success: true, data: await buildResumenDiario() });
});
