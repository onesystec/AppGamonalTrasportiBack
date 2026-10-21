import { Router } from "express";
import { exportar, fotos, me, seguimiento, servicios } from "../controllers/cliente.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { clienteMesQuerySchema, clienteServicioIdSchema } from "../validators/cliente.validator.js";

const router = Router();

// Usuarios de empresas cliente (solo lectura, siempre lo de su empresa). Cada ruta exige ademas su casilla de modulo.
router.use(authenticate, authorize("CLIENTE"));

router.get("/me", me);
router.get("/seguimiento", seguimiento);
router.get("/servicios", validate(clienteMesQuerySchema, "query"), servicios);
router.get("/exportar", validate(clienteMesQuerySchema, "query"), exportar);
router.get("/servicios/:id/fotos", validate(clienteServicioIdSchema, "params"), fotos);

export default router;
