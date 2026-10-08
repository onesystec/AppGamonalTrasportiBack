import { Router } from "express";
import { pendientes, recalcEstimacion, recalcParadas, reception, review, submit } from "../controllers/horas.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { pendientesQuerySchema, receptionSchema, reviewHorasSchema, submitHorasSchema } from "../validators/horas.validator.js";
import { idParamSchema } from "../validators/record.validator.js";

const router = Router();

router.use(authenticate);

// Cola de aprobacion (antes de "/:id" para no chocar con el UUID).
router.get("/pendientes", authorize("OWNER", "ADMIN"), validate(pendientesQuerySchema, "query"), pendientes);

router.post("/:id", validate(idParamSchema, "params"), validate(submitHorasSchema), submit);
router.post(
  "/:id/revision",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  validate(reviewHorasSchema),
  review
);

router.post("/:id/recepcion", validate(idParamSchema, "params"), validate(receptionSchema), reception);
router.post(
  "/:id/paradas",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  recalcParadas
);

router.post(
  "/:id/estimacion",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  recalcEstimacion
);

export default router;
