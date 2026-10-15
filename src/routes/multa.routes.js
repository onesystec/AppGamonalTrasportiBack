import { Router } from "express";
import { alerts, create, getById, list, remove, stats, suggestDriver, suggestForMulta, suggestForMultas, summary, update, uploadMyComprobante } from "../controllers/multa.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import {
  createMultaSchema,
  idParamSchema,
  listMultasQuerySchema,
  statsMultasQuerySchema,
  suggestDriverQuerySchema,
  suggestManyQuerySchema,
  summaryMultasQuerySchema,
  updateMultaSchema,
} from "../validators/multa.validator.js";

const router = Router();

// Las multas son de la oficina: el chofer no las ve (en su app solo tiene Combustible y Mancato Pagamento).
router.use(authenticate, authorize("OWNER", "ADMIN"));

// Foto o PDF de la multa y comprobante de pago: un archivo cada uno (imagen o PDF).
const uploadFiles = upload.fields([
  { name: "multa", maxCount: 1 },
  { name: "comprobante", maxCount: 1 },
]);

// Cargar, editar y borrar es solo de la oficina (se controla en el servicio); el chofer
// solo puede ver las suyas.
router.post("/", uploadFiles, validate(createMultaSchema), create);

router.get("/", validate(listMultasQuerySchema, "query"), list);

// Antes de "/:id" para que Express no lo tome como un id.
router.get("/summary", validate(summaryMultasQuerySchema, "query"), summary);
router.get("/stats", validate(statsMultasQuerySchema, "query"), stats);

// Campanita (OWNER/ADMIN y chofer, cada uno ve lo suyo) y sugerencia de chofer (oficina).
router.get("/alertas", alerts);
router.get("/sugerencia-chofer", validate(suggestDriverQuerySchema, "query"), suggestDriver);

router.get("/sugerencias", validate(suggestManyQuerySchema, "query"), suggestForMultas);

router.get("/:id", validate(idParamSchema, "params"), getById);
router.get("/:id/sugerencia", validate(idParamSchema, "params"), suggestForMulta);

router.patch("/:id", validate(idParamSchema, "params"), uploadFiles, validate(updateMultaSchema), update);

// El chofer sube el comprobante de una multa que paga el mismo; la oficina lo confirma.
router.post("/:id/comprobante-chofer", validate(idParamSchema, "params"), upload.single("comprobante"), uploadMyComprobante);

router.delete("/:id", validate(idParamSchema, "params"), remove);

export default router;
