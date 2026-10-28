import {
  getFinanzasResumenForActor,
  getGastosServiciosForActor,
  getPagosChoferesForActor,
  getPresenciasDataForActor,
  getKmRankingForActor,
} from "../services/finanzas.service.js";
import { buildPresenciasWorkbook, presenciasFileName } from "../services/presenciasExcel.service.js";
import { setKmhPagoForActor, setPagoAparteForActor } from "../services/velocidadPago.service.js";
import { getTarifasKm, setTarifasKm } from "../services/tarifas.service.js";
import { sharedForOffice } from "../utils/responseCache.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const resumen = asyncHandler(async (req, res) => {
  const result = await sharedForOffice("finanzas-resumen", req.user, req.query, () => getFinanzasResumenForActor(req.user, req.query));
  res.status(200).json({ success: true, data: { resumen: result } });
});

// Ranking de km de choferes y vehiculos: los mismos km que se pagan (ver getKmRankingForActor).
export const rankingKm = asyncHandler(async (req, res) => {
  const result = await sharedForOffice("finanzas-ranking-km", req.user, req.query, () => getKmRankingForActor(req.user, req.query));
  res.status(200).json({ success: true, data: { ranking: result } });
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

// Velocidad de pago (85, 90 o 95 km/h) de un chofer desde un mes.
export const velocidadPago = asyncHandler(async (req, res) => {
  const result = await setKmhPagoForActor(req.user, req.body);
  res.status(200).json({ success: true, data: { velocidadPago: result } });
});

export const pagoAparte = asyncHandler(async (req, res) => {
  const result = await setPagoAparteForActor(req.user, req.body);
  res.status(200).json({ success: true, data: { pagoAparte: result } });
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
