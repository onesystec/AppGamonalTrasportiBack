import { Router } from "express";
import { create, getById, list, listPersonal, remove, update } from "../controllers/document.controller.js";
import { authorize } from "../middlewares/authorize.js";
import { authenticate } from "../middlewares/authenticate.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import {
  createDocumentSchema,
  idParamSchema,
  listDocumentsQuerySchema,
  updateDocumentSchema,
} from "../validators/document.validator.js";

const router = Router();

router.use(authenticate);

router.post("/", upload.single("archivo"), validate(createDocumentSchema), create);

router.get("/", validate(listDocumentsQuerySchema, "query"), list);

router.get("/personal", authorize("RRHH"), listPersonal);

router.get("/:id", validate(idParamSchema, "params"), getById);

router.patch(
  "/:id",
  validate(idParamSchema, "params"),
  upload.single("archivo"),
  validate(updateDocumentSchema),
  update
);

router.delete("/:id", validate(idParamSchema, "params"), remove);

export default router;
