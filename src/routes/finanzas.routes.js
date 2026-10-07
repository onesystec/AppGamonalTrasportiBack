import { Router } from "express";
import { gastosServicios, pagos, resumen } from "../controllers/finanzas.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { monthQuerySchema, pagosQuerySchema } from "../validators/finanzas.validator.js";

const router = Router();

router.use(authenticate);

router.get("/resumen", validate(monthQuerySchema, "query"), resumen);
router.get("/pagos", validate(pagosQuerySchema, "query"), pagos);
router.get("/gastos-servicios", validate(monthQuerySchema, "query"), gastosServicios);

export default router;
