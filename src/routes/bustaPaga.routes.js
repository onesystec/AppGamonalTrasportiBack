import { Router } from "express";
import { constancia, destinatarios, fileUrl, list, remove, sign, upload } from "../controllers/bustaPaga.controller.js";
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

// Todos los usuarios (chofer, Responsable, Recursos Humanos y Admin) reciben su busta paga: ven solo las suyas
// y firman antes de abrirlas. Recursos Humanos y el Admin ademas las cargan y consultan las de todos.
router.get("/", validate(listBustaPagaQuerySchema, "query"), list);
router.get("/destinatarios", authorize("RRHH", "OWNER"), destinatarios);
router.post("/", authorize("RRHH", "OWNER"), bustaPagaUpload.single("archivo"), validate(uploadBustaPagaSchema), upload);
router.post("/:id/firma", validate(idParamSchema, "params"), validate(signBustaPagaSchema), sign);
router.get("/:id/archivo", validate(idParamSchema, "params"), fileUrl);
router.get("/:id/constancia", authorize("RRHH", "OWNER"), validate(idParamSchema, "params"), constancia);
router.delete("/:id", authorize("RRHH", "OWNER"), validate(idParamSchema, "params"), remove);

export default router;
