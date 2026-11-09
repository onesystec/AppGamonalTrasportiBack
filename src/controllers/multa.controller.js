import {
  createMultaForActor,
  deleteMultaForActor,
  exportMultasForActor,
  getMultaAlertsForActor,
  getMultaForActor,
  getMultaStatsForActor,
  getMultaSummaryForActor,
  listMultasForActor,
  suggestDriversForActor,
  updateMultaForActor,
  uploadMyComprobanteForActor,
} from "../services/multa.service.js";
import { suggestDriverForMultaForActor, suggestDriversForMultasForActor } from "../services/multaSugerencia.service.js";
import { buildMultasPdf, buildMultasXlsx } from "../services/multasInforme.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const multa = await createMultaForActor(req.user, req.body, req.files);
  res.status(201).json({ success: true, data: { multa } });
});

export const list = asyncHandler(async (req, res) => {
  const result = await listMultasForActor(req.user, req.query);
  res.status(200).json({ success: true, data: result });
});

// Texto de los filtros aplicados, para el encabezado del informe.
const FILTRO_LABELS = {
  estado: { VENCIDO: "Vencidas", PENDIENTE: "Pendientes de pago", PAGADO: "Pagadas" },
  datiEstado: {
    PENDIENTE: "Datos del conductor: faltan enviar",
    VENCIDO: "Datos del conductor: plazo vencido",
    SEMANA: "Datos del conductor: vencen en 7 dias",
    ENVIADO: "Datos del conductor: enviados",
    NO_REQUERIDO: "Datos del conductor: no requeridos",
  },
  quienPaga: { CHOFER_PAGO: "Paga el chofer", A_DESCONTAR: "A descontar" },
  titular: { SRL: "Titular S.R.L.", INDIVIDUAL: "Titular individual", SIN: "Sin titular" },
};
const describeFiltros = (q) => {
  const parts = [];
  for (const key of ["estado", "datiEstado", "quienPaga", "titular"]) if (q[key]) parts.push(FILTRO_LABELS[key][q[key]] ?? q[key]);
  if (q.targa) parts.push(`Targa ${q.targa}`);
  if (q.area) parts.push(`Area ${q.area}`);
  if (q.from || q.to) parts.push(`Recepcion ${q.from ?? "..."} a ${q.to ?? "..."}`);
  if (q.q) parts.push(`Busqueda "${q.q}"`);
  if (q.driverId) parts.push("Un chofer");
  return parts.length ? parts.join(" - ") : "todas las multas";
};

// Informe de multas en Excel o PDF con los filtros de la lista (formato de la lista maestra de datos del conductor).
export const exportInforme = asyncHandler(async (req, res) => {
  const { items, today } = await exportMultasForActor(req.user, req.query);
  const [y, m, d] = today.split("-");
  const meta = {
    items,
    titulo: req.query.datiEstado ? "Multas - datos del conductor (art. 126-bis)" : "Informe de multas",
    filtros: describeFiltros(req.query),
    generado: `${d}/${m}/${y}`,
  };
  const pdf = req.query.formato === "pdf";
  const buffer = pdf ? await buildMultasPdf(meta) : await buildMultasXlsx(meta);
  res.setHeader("Content-Type", pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="multas_${today}.${pdf ? "pdf" : "xlsx"}"`);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(Buffer.from(buffer));
});

export const summary = asyncHandler(async (req, res) => {
  const result = await getMultaSummaryForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { summary: result } });
});

export const stats = asyncHandler(async (req, res) => {
  const result = await getMultaStatsForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { stats: result } });
});

export const getById = asyncHandler(async (req, res) => {
  const multa = await getMultaForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { multa } });
});

export const update = asyncHandler(async (req, res) => {
  const multa = await updateMultaForActor(req.user, req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { multa } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteMultaForActor(req.user, req.params.id);
  res.status(204).send();
});

export const alerts = asyncHandler(async (req, res) => {
  const result = await getMultaAlertsForActor(req.user);
  res.status(200).json({ success: true, data: { alerts: result } });
});

export const suggestDriver = asyncHandler(async (req, res) => {
  const result = await suggestDriversForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { sugerencia: result } });
});

export const uploadMyComprobante = asyncHandler(async (req, res) => {
  const multa = await uploadMyComprobanteForActor(req.user, req.params.id, req.file);
  res.status(200).json({ success: true, data: { multa } });
});

// Quien pudo ser el responsable de una multa sin chofer (solo sugiere; la oficina decide).
export const suggestForMulta = asyncHandler(async (req, res) => {
  const sugerencia = await suggestDriverForMultaForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { sugerencia } });
});

export const suggestForMultas = asyncHandler(async (req, res) => {
  const sugerencias = await suggestDriversForMultasForActor(req.user, req.query.ids);
  res.status(200).json({ success: true, data: { sugerencias } });
});
