import { Router } from "express";
import { leer, listar } from "../controllers/cambios.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { cambiosLeerSchema, cambiosQuerySchema } from "../validators/cliente.validator.js";

const router = Router();

// Cambios que los clientes hacen en su hoja: lista de alertas (servicios ya entregados que se editaron) y el historial de un servicio (?recordId=).
router.use(authenticate, authorize("OWNER", "ADMIN"));

router.get("/", validate(cambiosQuerySchema, "query"), listar);
router.post("/leer", validate(cambiosLeerSchema), leer);

export default router;
