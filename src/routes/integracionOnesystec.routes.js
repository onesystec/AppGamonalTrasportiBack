import { Router } from "express";
import { choferes, usos } from "../controllers/integracionOnesystec.controller.js";
import { requireIntegrationKey } from "../middlewares/integrationKey.js";
import { validate } from "../middlewares/validate.js";
import { usosQuerySchema } from "../validators/integracionOnesystec.validator.js";

const router = Router();

// Para OneSystec, no para personas: sin authenticate (no hay sesion de usuario), solo con la clave de servicio en
// "X-Integration-Key" (ONESYSTEC_INTEGRATION_KEY). Todo de solo lectura.
router.use(requireIntegrationKey);

router.get("/choferes", choferes);
router.get("/usos", validate(usosQuerySchema, "query"), usos);

export default router;
