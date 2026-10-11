import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { listPeajes } from "../services/peajes.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("OWNER", "ADMIN"));

// Catalogo de peajes de Italia (OpenStreetMap) para pintarlos en los mapas. Casi no cambia: el navegador lo puede guardar.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, max-age=3600");
    res.status(200).json({ success: true, data: { peajes: await listPeajes(), fuente: "OpenStreetMap (ODbL)" } });
  })
);

export default router;
