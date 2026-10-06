import { Router } from "express";
import { cleanup, remove } from "../controllers/recordFile.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { fileIdParamSchema } from "../validators/recordFile.validator.js";

const router = Router();

router.use(authenticate);

// OWNER: borrado en bloque e irreversible de fotos vencidas (ver RECORD_FILE_RETENTION_DAYS).
router.post("/cleanup", authorize("OWNER"), cleanup);

router.delete("/:id", authorize("OWNER", "ADMIN"), validate(fileIdParamSchema, "params"), remove);

export default router;
