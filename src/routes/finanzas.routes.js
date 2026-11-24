import { FINANCE_ROLES } from "../utils/financeAccess.js";
import { Router } from "express";
import { getTarifas, gastosServicios, pagoAparte, pagoServicios, pagos, presencias, putTarifas, rankingKm, resumen, velocidadPago } from "../controllers/finanzas.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { monthQuerySchema, pagoAparteSchema, pagoServiciosQuerySchema, pagosQuerySchema, presenciasQuerySchema, rankingKmQuerySchema, tarifasKmSchema, velocidadPagoSchema } from "../validators/finanzas.validator.js";

const router = Router();

router.use(authenticate);

router.get("/resumen", validate(monthQuerySchema, "query"), resumen);
router.get("/pagos", validate(pagosQuerySchema, "query"), pagos);
router.get("/pago-servicios", authorize(...FINANCE_ROLES), validate(pagoServiciosQuerySchema, "query"), pagoServicios);
router.get("/ranking-km", authorize(...FINANCE_ROLES), validate(rankingKmQuerySchema, "query"), rankingKm);
router.get("/presencias", authorize(...FINANCE_ROLES), validate(presenciasQuerySchema, "query"), presencias);
router.put("/pago-aparte", authorize("OWNER", "RRHH"), validate(pagoAparteSchema), pagoAparte);
router.put("/velocidad-pago", authorize(...FINANCE_ROLES), validate(velocidadPagoSchema), velocidadPago);
router.get("/gastos-servicios", validate(monthQuerySchema, "query"), gastosServicios);

// Tarifas por km (precio por km de cada categoria de vehiculo y la de DHL/AB Service): las ve la oficina y las cambia el Admin.
router.get("/tarifas-km", authorize(...FINANCE_ROLES), getTarifas);
router.put("/tarifas-km", authorize("OWNER", "RRHH"), validate(tarifasKmSchema), putTarifas);

export default router;
