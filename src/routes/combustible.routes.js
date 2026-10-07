import { Router } from "express";
import {
  candidates,
  create,
  getById,
  list,
  metodos,
  rematch,
  remove,
  stats,
  summary,
  update,
} from "../controllers/combustible.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import {
  createCombustibleSchema,
  idParamSchema,
  listCombustibleQuerySchema,
  statsCombustibleQuerySchema,
  summaryCombustibleQuerySchema,
  updateCombustibleSchema,
} from "../validators/combustible.validator.js";

const router = Router();

router.use(authenticate);

// Comprobante: un archivo (imagen o PDF).
const uploadFiles = upload.fields([{ name: "comprobante", maxCount: 1 }]);

router.post("/", uploadFiles, validate(createCombustibleSchema), create);

router.get("/", validate(listCombustibleQuerySchema, "query"), list);

// Antes de "/:id" para que Express no lo tome como un id.
router.get("/summary", validate(summaryCombustibleQuerySchema, "query"), summary);

router.get("/stats", validate(statsCombustibleQuerySchema, "query"), stats);

router.get("/metodos", metodos);

// Vuelve a evaluar las cargas que la oficina no fijo a mano.
router.post("/reasignar", rematch);

router.get("/:id", validate(idParamSchema, "params"), getById);

router.get("/:id/candidatos", validate(idParamSchema, "params"), candidates);

router.patch("/:id", validate(idParamSchema, "params"), uploadFiles, validate(updateCombustibleSchema), update);

router.delete("/:id", validate(idParamSchema, "params"), remove);

export default router;
