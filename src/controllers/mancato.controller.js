import {
  createMancatoForActor,
  deleteMancatoForActor,
  exportMancatosForActor,
  getMancatoForActor,
  getMancatoStatsForActor,
  listMancatoCandidatesForActor,
  rematchMancatosForActor,
  reevaluarMesForActor,
  getMancatoMesesForActor,
  getMancatoSummaryForActor,
  listMancatosForActor,
  updateMancatoForActor,
} from "../services/mancato.service.js";
import { buildMancatoInforme } from "../services/mancatoInforme.service.js";
import { sharedForOffice } from "../utils/responseCache.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const create = asyncHandler(async (req, res) => {
  const mancato = await createMancatoForActor(req.user, req.body, req.files);
  res.status(201).json({ success: true, data: { mancato } });
});

// Texto de los filtros aplicados, para el encabezado del informe.
const ESTADOS = { PENDIENTE: "Pendientes", VENCIDO: "Vencidos", HISTORIAL_VENCIDO: "Vencidos (historial)", OBSERVADO: "Observados", PAGADO: "Pagados" };
const VENCE = { HOY: "Vencen hoy", MANANA: "Vencen manana", HOY_MANANA: "Vencen hoy o manana" };
const describeFiltros = (q) => {
  const parts = [];
  if (q.estado) parts.push(ESTADOS[q.estado] ?? q.estado);
  if (q.vence) parts.push(VENCE[q.vence] ?? q.vence);
  if (q.asignacion) parts.push(`Asignacion ${q.asignacion}`);
  if (q.fueraDePlazo) parts.push(q.fueraDePlazo === "true" ? "Subidos fuera de plazo" : "Subidos en plazo");
  if (q.targa) parts.push(`Targa ${q.targa}`);
  if (q.from || q.to) parts.push(`Transito ${q.from ?? "..."} a ${q.to ?? "..."}`);
  if (q.q) parts.push(`Busqueda "${q.q}"`);
  if (q.driverId) parts.push("Un chofer");
  return parts.length ? parts.join(" - ") : "todos los mancati";
};

// Informe de Mancato Pagamento en Excel o PDF con los filtros de la lista.
export const exportInforme = asyncHandler(async (req, res) => {
  const { items, today } = await exportMancatosForActor(req.user, req.query);
  const [y, m, d] = today.split("-");
  const pdf = req.query.formato === "pdf";
  const buffer = await buildMancatoInforme({ items, formato: req.query.formato, filtros: describeFiltros(req.query), generado: `${d}/${m}/${y}` });
  res.setHeader("Content-Type", pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="mancato_pagamento_${today}.${pdf ? "pdf" : "xlsx"}"`);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(Buffer.from(buffer));
});

export const list = asyncHandler(async (req, res) => {
  const result = await listMancatosForActor(req.user, req.query);
  res.status(200).json({ success: true, data: result });
});

export const meses = asyncHandler(async (req, res) => {
  const result = await sharedForOffice("mancato-meses", req.user, req.query, () => getMancatoMesesForActor(req.user, req.query));
  res.status(200).json({ success: true, data: { meses: result } });
});

export const summary = asyncHandler(async (req, res) => {
  const result = await sharedForOffice("mancato-summary", req.user, req.query, () => getMancatoSummaryForActor(req.user, req.query));
  res.status(200).json({ success: true, data: { summary: result } });
});

export const getById = asyncHandler(async (req, res) => {
  const mancato = await getMancatoForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { mancato } });
});

export const update = asyncHandler(async (req, res) => {
  const mancato = await updateMancatoForActor(req.user, req.params.id, req.body, req.files);
  res.status(200).json({ success: true, data: { mancato } });
});

export const remove = asyncHandler(async (req, res) => {
  await deleteMancatoForActor(req.user, req.params.id);
  res.status(204).send();
});

export const stats = asyncHandler(async (req, res) => {
  const result = await sharedForOffice("mancato-stats", req.user, req.query, () => getMancatoStatsForActor(req.user, req.query));
  res.status(200).json({ success: true, data: { stats: result } });
});

export const candidates = asyncHandler(async (req, res) => {
  const items = await listMancatoCandidatesForActor(req.user, req.params.id);
  res.status(200).json({ success: true, data: { candidatos: items } });
});

export const reevaluar = asyncHandler(async (req, res) => {
  const resultado = await reevaluarMesForActor(req.user, req.body);
  res.status(200).json({ success: true, data: { resultado } });
});

export const rematch = asyncHandler(async (req, res) => {
  const result = await rematchMancatosForActor(req.user);
  res.status(200).json({ success: true, data: { resultado: result } });
});
