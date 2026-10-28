import { Router } from "express";
import { create, list, remove, review, update } from "../controllers/otroGasto.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import { idParamSchema } from "../validators/record.validator.js";
import {
  createOtroGastoSchema,
  listOtrosGastosQuerySchema,
  reviewOtroGastoSchema,
  updateOtroGastoSchema,
} from "../validators/otroGasto.validator.js";

// Comprobante opcional: una foto o un PDF.
const uploadComprobante = upload.fields([{ name: "comprobante", maxCount: 1 }]);

const router = Router();
router.use(authenticate);

// El chofer (y el Admin/Owner en su modo chofer) carga y corrige los suyos; la oficina los ve todos y los reembolsa o rechaza.
router.get("/", validate(listOtrosGastosQuerySchema, "query"), list);
router.post("/", authorize("CHOFER", "OWNER", "ADMIN"), uploadComprobante, validate(createOtroGastoSchema), create);
router.patch("/:id", authorize("CHOFER", "OWNER", "ADMIN"), validate(idParamSchema, "params"), uploadComprobante, validate(updateOtroGastoSchema), update);
router.delete("/:id", authorize("CHOFER", "OWNER", "ADMIN"), validate(idParamSchema, "params"), remove);
router.post("/:id/revision", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), validate(reviewOtroGastoSchema), review);

export default router;
