import {
  createSolicitudCliente,
  deleteSolicitudCliente,
  listSolicitudesCliente,
  listSolicitudesForActor,
  rechazarSolicitudForActor,
  updateSolicitudCliente,
} from "../services/solicitud.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Usuario cliente (rutas /cliente/solicitudes)
export const listCliente = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: { items: await listSolicitudesCliente(req.user) } });
});

export const createCliente = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await createSolicitudCliente(req.user, req.body) });
});

export const updateCliente = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await updateSolicitudCliente(req.user, req.params.id, req.body) });
});

export const removeCliente = asyncHandler(async (req, res) => {
  await deleteSolicitudCliente(req.user, req.params.id);
  res.status(200).json({ success: true, data: null });
});

// Oficina (rutas /solicitudes)
export const listOficina = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: { items: await listSolicitudesForActor(req.user, req.query) } });
});

export const rechazar = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await rechazarSolicitudForActor(req.user, req.params.id, req.body) });
});
