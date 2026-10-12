import { Router } from "express";
import { create, list, remove, review, update } from "../controllers/trabajoAdicional.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import { idParamSchema } from "../validators/record.validator.js";
import {
  createTrabajoAdicionalSchema,
  listTrabajosAdicionalesQuerySchema,
  reviewTrabajoAdicionalSchema,
  updateTrabajoAdicionalSchema,
} from "../validators/trabajoAdicional.validator.js";

const router = Router();
router.use(authenticate);

// El chofer carga y corrige los suyos (con una foto o comprobante opcional); la oficina los revisa.
router.get("/", validate(listTrabajosAdicionalesQuerySchema, "query"), list);
router.post("/", authorize("CHOFER"), upload.single("foto"), validate(createTrabajoAdicionalSchema), create);
router.patch("/:id", authorize("CHOFER"), validate(idParamSchema, "params"), upload.single("foto"), validate(updateTrabajoAdicionalSchema), update);
router.delete("/:id", authorize("CHOFER"), validate(idParamSchema, "params"), remove);
router.post("/:id/revision", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), validate(reviewTrabajoAdicionalSchema), review);

export default router;
