import { Router } from "express";
import { getTarifas, gastosServicios, pagos, putTarifas, resumen } from "../controllers/finanzas.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { monthQuerySchema, pagosQuerySchema, tarifasKmSchema } from "../validators/finanzas.validator.js";

const router = Router();

router.use(authenticate);

router.get("/resumen", validate(monthQuerySchema, "query"), resumen);
router.get("/pagos", validate(pagosQuerySchema, "query"), pagos);
router.get("/gastos-servicios", validate(monthQuerySchema, "query"), gastosServicios);

// Tarifas por km (precio por km de cada categoria de vehiculo y la de DHL/AB Service): las ve la oficina y las cambia el Admin.
router.get("/tarifas-km", authorize("OWNER", "ADMIN"), getTarifas);
router.put("/tarifas-km", authorize("OWNER"), validate(tarifasKmSchema), putTarifas);

export default router;
