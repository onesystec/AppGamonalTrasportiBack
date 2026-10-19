import {
  getFinanzasResumenForActor,
  getGastosServiciosForActor,
  getPagosChoferesForActor,
  getPresenciasDataForActor,
} from "../services/finanzas.service.js";
import { buildPresenciasWorkbook, presenciasFileName } from "../services/presenciasExcel.service.js";
import { getTarifasKm, setTarifasKm } from "../services/tarifas.service.js";
import { sharedForOffice } from "../utils/responseCache.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const resumen = asyncHandler(async (req, res) => {
  const result = await sharedForOffice("finanzas-resumen", req.user, req.query, () => getFinanzasResumenForActor(req.user, req.query));
  res.status(200).json({ success: true, data: { resumen: result } });
});

export const pagos = asyncHandler(async (req, res) => {
  const result = await getPagosChoferesForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { pagos: result } });
});

// Planilla de presencias del mes en Excel (una plaza por chofer con sus horas por dia).
export const presencias = asyncHandler(async (req, res) => {
  const data = await getPresenciasDataForActor(req.user, req.query);
  const buffer = await buildPresenciasWorkbook({ month: data.month, choferes: data.choferes, formato: req.query.formato });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${presenciasFileName(data.month)}"`);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(Buffer.from(buffer));
});

export const gastosServicios = asyncHandler(async (req, res) => {
  const result = await getGastosServiciosForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { gastos: result } });
});

export const getTarifas = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { tarifas: await getTarifasKm() } });
});

export const putTarifas = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { tarifas: await setTarifasKm(req.body) } });
});
