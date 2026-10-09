import { Router } from "express";
import { create, list, remove, update } from "../controllers/client.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { createClientSchema, idParamSchema, updateClientSchema } from "../validators/client.validator.js";

const router = Router();

router.use(authenticate);

// El chofer no necesita la lista de clientes.
router.get("/", authorize("OWNER", "ADMIN"), list);
router.post("/", authorize("OWNER", "ADMIN"), validate(createClientSchema), create);
router.patch(
  "/:id",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  validate(updateClientSchema),
  update
);
router.delete("/:id", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), remove);

export default router;
