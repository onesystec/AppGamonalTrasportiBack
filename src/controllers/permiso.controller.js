import {
  cancelPermisoForActor,
  createPermisoForActor,
  getAttendanceOverviewForActor,
  getCalendarForActor,
  getPermisosConfig,
  listPermisosForActor,
  reviewPermisoForActor,
  setPermisosConfig,
} from "../services/permiso.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const calendar = asyncHandler(async (req, res) => {
  const data = await getCalendarForActor(req.user, req.query);
  res.status(200).json({ success: true, data });
});

export const list = asyncHandler(async (req, res) => {
  const items = await listPermisosForActor(req.user, req.query);
  res.status(200).json({ success: true, data: { items } });
});

export const create = asyncHandler(async (req, res) => {
  const permiso = await createPermisoForActor(req.user, req.body);
  res.status(201).json({ success: true, data: permiso });
});

export const review = asyncHandler(async (req, res) => {
  const permiso = await reviewPermisoForActor(req.user, req.params.id, req.body);
  res.status(200).json({ success: true, data: permiso });
});

export const remove = asyncHandler(async (req, res) => {
  await cancelPermisoForActor(req.user, req.params.id);
  res.status(204).send();
});

export const getConfig = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await getPermisosConfig() });
});

export const putConfig = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await setPermisosConfig(req.body) });
});

export const overview = asyncHandler(async (req, res) => {
  const data = await getAttendanceOverviewForActor(req.user, req.query);
  res.status(200).json({ success: true, data });
});
