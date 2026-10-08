import { Router } from "express";
import { calendar, create, getConfig, list, overview, putConfig, remove, review } from "../controllers/permiso.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { idParamSchema } from "../validators/record.validator.js";
import {
  calendarQuerySchema,
  createPermisoSchema,
  listPermisosQuerySchema,
  overviewQuerySchema,
  permisosConfigSchema,
  reviewPermisoSchema,
} from "../validators/permiso.validator.js";

const router = Router();

router.use(authenticate);

router.get("/calendario", validate(calendarQuerySchema, "query"), calendar);
router.get("/resumen", authorize("OWNER", "ADMIN"), validate(overviewQuerySchema, "query"), overview);
router.get("/config", getConfig);
router.put("/config", authorize("OWNER", "ADMIN"), validate(permisosConfigSchema), putConfig);
router.get("/", validate(listPermisosQuerySchema, "query"), list);
router.post("/", validate(createPermisoSchema), create);
router.post(
  "/:id/revision",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  validate(reviewPermisoSchema),
  review
);
router.delete("/:id", validate(idParamSchema, "params"), remove);

export default router;
