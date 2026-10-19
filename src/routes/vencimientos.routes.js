import { Router } from "express";
import { listar } from "../controllers/vencimientos.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";

const router = Router();

router.use(authenticate);

// Owner, Responsables (solo su zona) y Recursos Humanos.
router.get("/", authorize("OWNER", "ADMIN", "RRHH"), listar);

export default router;
