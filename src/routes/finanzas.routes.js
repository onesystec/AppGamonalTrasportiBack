import { Router } from "express";
import { getTarifas, gastosServicios, pagos, presencias, putTarifas, resumen } from "../controllers/finanzas.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { monthQuerySchema, pagosQuerySchema, presenciasQuerySchema, tarifasKmSchema } from "../validators/finanzas.validator.js";

const router = Router();

router.use(authenticate);

router.get("/resumen", validate(monthQuerySchema, "query"), resumen);
router.get("/pagos", validate(pagosQuerySchema, "query"), pagos);
router.get("/presencias", authorize("OWNER", "ADMIN"), validate(presenciasQuerySchema, "query"), presencias);
router.get("/gastos-servicios", validate(monthQuerySchema, "query"), gastosServicios);

// Tarifas por km (precio por km de cada categoria de vehiculo y la de DHL/AB Service): las ve la oficina y las cambia el Admin.
router.get("/tarifas-km", authorize("OWNER", "ADMIN"), getTarifas);
router.put("/tarifas-km", authorize("OWNER"), validate(tarifasKmSchema), putTarifas);

export default router;
