import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { contextoVehiculo, declararVehiculo, listarCronologia } from "../services/cronologiaVehicular.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
const declaracionSchema = z.object({
  vehicleId: z.string().uuid().nullable(),
  continuar: z.boolean().default(false),
});

router.use(authenticate);
router.get("/", authorize("CHOFER", "OWNER", "ADMIN", "RRHH"), asyncHandler(async (req, res) => {
  res.json({ data: await listarCronologia(req.user) });
}));
router.get("/confirmacion", authorize("CHOFER"), asyncHandler(async (req, res) => {
  res.json({ data: await contextoVehiculo(req.user) });
}));
router.post("/confirmacion", authorize("CHOFER"), validate(declaracionSchema), asyncHandler(async (req, res) => {
  await declararVehiculo(req.user, req.body);
  res.status(204).end();
}));

export default router;
