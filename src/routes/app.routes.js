import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { getAndroidUpdate } from "../services/appUpdate.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate);

// Ultima version publicada del APK (o null si no se publico ninguna) con una URL firmada para descargarla.
router.get(
  "/android",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, data: { android: await getAndroidUpdate() } });
  })
);

export default router;
