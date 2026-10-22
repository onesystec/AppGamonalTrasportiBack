import { Router } from "express";
import { emit, emitted, emittedDetail, fileUrl, mine, options, remind, remove, sign } from "../controllers/memorandum.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { emitMemorandumSchema, idParamSchema, signMemorandumSchema } from "../validators/memorandum.validator.js";

const router = Router();

router.use(authenticate);

// Todos los usuarios reciben memorandums: ven el asunto y, para abrirlos, primero dan su acuse o su firma.
router.get("/mine", mine);
router.post("/:id/firma", validate(idParamSchema, "params"), validate(signMemorandumSchema), sign);
router.get("/:id/archivo", validate(idParamSchema, "params"), fileUrl);

// Emitir y seguir los emitidos: Admin, Recursos Humanos y Responsables (cada servicio limita a quien puede llegar y que tipos).
const emisores = authorize("OWNER", "RRHH", "ADMIN");
router.get("/opciones", emisores, options);
router.get("/emitidos", emisores, emitted);
router.get("/emitidos/:id", emisores, validate(idParamSchema, "params"), emittedDetail);
router.post("/", emisores, validate(emitMemorandumSchema), emit);
router.post("/:id/recordar", emisores, validate(idParamSchema, "params"), remind);
router.delete("/:id", emisores, validate(idParamSchema, "params"), remove);

export default router;
