import { Router } from "express";
import {
  candidates,
  create,
  getById,
  list,
  rematch,
  remove,
  stats,
  summary,
  update,
} from "../controllers/mancato.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import {
  createMancatoSchema,
  idParamSchema,
  listMancatosQuerySchema,
  statsMancatosQuerySchema,
  summaryMancatosQuerySchema,
  updateMancatoSchema,
} from "../validators/mancato.validator.js";

const router = Router();

router.use(authenticate);

// Foto del aviso y comprobante de pago: un archivo cada uno (imagen o PDF).
const uploadFiles = upload.fields([
  { name: "foto", maxCount: 1 },
  { name: "comprobante", maxCount: 1 },
]);

router.post("/", uploadFiles, validate(createMancatoSchema), create);

router.get("/", validate(listMancatosQuerySchema, "query"), list);

// Antes de "/:id" para que Express no lo tome como un id.
router.get("/summary", validate(summaryMancatosQuerySchema, "query"), summary);

router.get("/stats", validate(statsMancatosQuerySchema, "query"), stats);

// Vuelve a evaluar los mancatos que la oficina no fijo a mano.
router.post("/reasignar", rematch);

router.get("/:id", validate(idParamSchema, "params"), getById);

router.get("/:id/candidatos", validate(idParamSchema, "params"), candidates);

router.patch("/:id", validate(idParamSchema, "params"), uploadFiles, validate(updateMancatoSchema), update);

router.delete("/:id", validate(idParamSchema, "params"), remove);

export default router;
