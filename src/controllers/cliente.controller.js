import { getClienteMe, getEnVivoCliente, getFotosCliente, getRutaCliente, getSeguimientoCliente, listServiciosCliente, requireModulo } from "../services/cliente.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const me = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { cliente: getClienteMe(req.user) } });
});

export const seguimiento = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: { seguimiento: await getSeguimientoCliente(req.user) } });
});

export const enVivo = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: await getEnVivoCliente(req.user) });
});

export const servicios = asyncHandler(async (req, res) => {
  requireModulo(req.user, "HISTORIAL");
  res.status(200).json({ success: true, data: await listServiciosCliente(req.user, req.query) });
});

// Mismos datos que el historial, pero con su propia casilla (Excel): el archivo se arma en el celular o en el navegador.
export const exportar = asyncHandler(async (req, res) => {
  requireModulo(req.user, "EXCEL");
  res.status(200).json({ success: true, data: await listServiciosCliente(req.user, req.query) });
});

export const fotos = asyncHandler(async (req, res) => {
  requireModulo(req.user, "FOTOS");
  res.status(200).json({ success: true, data: await getFotosCliente(req.user, req.params.id) });
});

export const ruta = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: await getRutaCliente(req.user, req.params.id) });
});
