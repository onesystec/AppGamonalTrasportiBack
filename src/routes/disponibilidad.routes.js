import { Router } from "express";
import { disponibilidad } from "../controllers/disponibilidad.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { disponibilidadQuerySchema } from "../validators/disponibilidad.validator.js";

const router = Router();
router.use(authenticate);

// Disponibilidad de choferes (permisos y servicios) y vehiculos (servicios y mantenimiento) dia por dia: solo la oficina.
router.get("/", authorize("OWNER", "ADMIN"), validate(disponibilidadQuerySchema, "query"), disponibilidad);

export default router;
