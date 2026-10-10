import {
  getMetasConfig,
  getMyProgress,
  listDriversProgress,
  setMetasConfig,
} from "../services/meta.service.js";
import { getMyDrivingStyle } from "../services/drivingStyle.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const getConfig = asyncHandler(async (_req, res) => {
  res.status(200).json({ success: true, data: { metas: await getMetasConfig() } });
});

export const putConfig = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { metas: await setMetasConfig(req.body) } });
});

export const myProgress = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await getMyProgress(req.user, req.query) });
});

export const myDrivingStyle = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { estilo: await getMyDrivingStyle(req.user) } });
});

export const driversProgress = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await listDriversProgress(req.user, req.query) });
});
