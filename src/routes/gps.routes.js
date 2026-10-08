import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { getGpsStatusForOffice } from "../services/gpsRespaldo.service.js";

const router = Router();

router.use(authenticate);

// Estado del GPS de la flota (OneSystec) y del respaldo con el celular. ?verificar=1 fuerza una
// comprobacion nueva (como mucho una cada 15 segundos).
router.get(
  "/estado",
  authorize("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const data = await getGpsStatusForOffice({ verificar: req.query.verificar === "1" });
    res.status(200).json({ success: true, data });
  })
);

export default router;
