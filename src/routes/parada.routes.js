import { Router } from "express";
import { getReturn, list, putReturn, status } from "../controllers/parada.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { paradasQuerySchema, retornoSchema } from "../validators/parada.validator.js";

const router = Router();

router.use(authenticate, authorize("OWNER", "ADMIN"));

router.get("/", validate(paradasQuerySchema, "query"), list);
router.get("/estado", status);
router.get("/retorno", getReturn);
router.put("/retorno", validate(retornoSchema), putReturn);

export default router;
