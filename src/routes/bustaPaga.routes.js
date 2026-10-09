import { Router } from "express";
import { constancia, fileUrl, list, remove, sign, upload } from "../controllers/bustaPaga.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { bustaPagaUpload } from "../middlewares/bustaPagaUpload.js";
import { validate } from "../middlewares/validate.js";
import {
  idParamSchema,
  listBustaPagaQuerySchema,
  signBustaPagaSchema,
  uploadBustaPagaSchema,
} from "../validators/bustaPaga.validator.js";

const router = Router();

router.use(authenticate);

// Recursos Humanos (y el Admin) cargan y consultan; el chofer solo ve las suyas, y firma antes de abrirlas.
router.get("/", authorize("RRHH", "OWNER", "CHOFER"), validate(listBustaPagaQuerySchema, "query"), list);
router.post("/", authorize("RRHH", "OWNER"), bustaPagaUpload.single("archivo"), validate(uploadBustaPagaSchema), upload);
router.post("/:id/firma", authorize("CHOFER"), validate(idParamSchema, "params"), validate(signBustaPagaSchema), sign);
router.get("/:id/archivo", authorize("RRHH", "OWNER", "CHOFER"), validate(idParamSchema, "params"), fileUrl);
router.get("/:id/constancia", authorize("RRHH", "OWNER"), validate(idParamSchema, "params"), constancia);
router.delete("/:id", authorize("RRHH", "OWNER"), validate(idParamSchema, "params"), remove);

export default router;
