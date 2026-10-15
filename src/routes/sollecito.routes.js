import { Router } from "express";
import { create, getById, list, remove, update } from "../controllers/sollecito.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import {
  createSollecitoSchema,
  idParamSchema,
  listSollecitiQuerySchema,
  updateSollecitoSchema,
} from "../validators/sollecito.validator.js";

const router = Router();

// Los solicitos son de la oficina: el chofer no los ve.
router.use(authenticate, authorize("OWNER", "ADMIN"));

// PDF (o foto) del solicito y comprobante de pago.
const uploadFiles = upload.fields([
  { name: "archivo", maxCount: 1 },
  { name: "comprobante", maxCount: 1 },
]);

router.get("/", validate(listSollecitiQuerySchema, "query"), list);
router.post("/", uploadFiles, validate(createSollecitoSchema), create);
router.get("/:id", validate(idParamSchema, "params"), getById);
router.patch("/:id", validate(idParamSchema, "params"), uploadFiles, validate(updateSollecitoSchema), update);
router.delete("/:id", validate(idParamSchema, "params"), remove);

export default router;
