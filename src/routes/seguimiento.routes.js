import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { getRutaSeguimiento, getSeguimientoForActor } from "../services/seguimiento.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate, authorize("OWNER", "ADMIN"));

// Servicios en camino con su posicion (GPS del vehiculo, del celular o simulada), llegada estimada y alertas.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, data: await getSeguimientoForActor(req.user) });
  })
);

// Ruta del servicio elegido para dibujarla en el mapa.
router.get(
  "/:id/ruta",
  asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, data: { ruta: await getRutaSeguimiento(req.user, req.params.id) } });
  })
);

export default router;
