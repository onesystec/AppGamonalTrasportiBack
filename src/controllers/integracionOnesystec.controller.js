import { listChoferes, listUsos } from "../services/integracionOnesystec.service.js";
import { trabajadoresFinanzas } from "../services/integracionFinanzas.service.js";
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

// Trabajadores y produccion del mes para la app de finanzas (Planilla). Solo lectura.
export const finanzasTrabajadores = asyncHandler(async (req, res) => {
  const mes = typeof req.query.mes === "string" && req.query.mes ? req.query.mes : new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date()).slice(0, 7);
  res.status(200).json({ success: true, data: await trabajadoresFinanzas({ mes }) });
});
