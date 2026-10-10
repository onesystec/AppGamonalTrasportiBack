import { Router } from "express";
import { driversProgress, getConfig, myDrivingStyle, myProgress, putConfig } from "../controllers/meta.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { metasConfigSchema, progressQuerySchema } from "../validators/meta.validator.js";

const router = Router();

router.use(authenticate);

// Meta mensual de km por nivel (Novato / Master / Senior): la define el Admin a mano.
router.get("/config", authorize("OWNER", "ADMIN"), getConfig);
router.put("/config", authorize("OWNER"), validate(metasConfigSchema), putConfig);

// Avance del propio usuario y, para la oficina, el de todos los que manejan.
router.get("/mi-progreso", validate(progressQuerySchema, "query"), myProgress);
// Puntaje de estilo de manejo (OneSystec) de quien consulta; va aparte para no demorar la meta si el GPS tarda.
router.get("/mi-estilo-manejo", myDrivingStyle);
router.get("/choferes", authorize("OWNER", "ADMIN"), validate(progressQuerySchema, "query"), driversProgress);

export default router;
