import {
  crearDesdeTextoForActor,
  createSolicitudCliente,
  deleteSolicitudCliente,
  getDetalleSolicitudCliente,
  leerTextoCliente,
  leerTextoForActor,
  listSolicitudesCliente,
  listSolicitudesForActor,
  registrarDesdeTextoCliente,
  rutaEstimadaForActor,
  rechazarSolicitudForActor,
  updateSolicitudCliente,
} from "../services/solicitud.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Usuario cliente (rutas /cliente/solicitudes)
export const listCliente = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: { items: await listSolicitudesCliente(req.user, req.query) } });
});

export const createCliente = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await createSolicitudCliente(req.user, req.body) });
});

// Registrar pegando solo el texto: se lee y se crea la solicitud de una vez (el cliente completa lo que falte en su hoja).
export const registrarDesdeTextoDelCliente = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await registrarDesdeTextoCliente(req.user, req.body) });
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

export const rutaEstimada = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await rutaEstimadaForActor(req.user, req.params.id) });
});

export const rechazar = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await rechazarSolicitudForActor(req.user, req.params.id, req.body) });
});

// Servicio desde un texto pegado: leer (no guarda) y crear la solicitud pendiente.
export const leerTexto = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await leerTextoForActor(req.user, req.body) });
});

export const crearDesdeTexto = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await crearDesdeTextoForActor(req.user, req.body) });
});

// Usuario cliente: leer un texto de DHL para rellenar su solicitud y el detalle (chofer, targa, bolla) de una ya aceptada.
export const leerTextoDelCliente = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await leerTextoCliente(req.user, req.body) });
});

export const detalleCliente = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({ success: true, data: await getDetalleSolicitudCliente(req.user, req.params.id) });
});
