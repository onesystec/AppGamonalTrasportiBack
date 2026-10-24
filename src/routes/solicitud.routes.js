import { Router } from "express";
import { listOficina, rechazar } from "../controllers/solicitud.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { listSolicitudesQuerySchema, rechazarSolicitudSchema, solicitudIdSchema } from "../validators/solicitud.validator.js";

const router = Router();

// Solicitudes de servicio de los usuarios cliente (Piazza), vistas por la oficina. Aceptar = crear el servicio con `solicitudId` (POST /records).
router.use(authenticate, authorize("OWNER", "ADMIN"));

router.get("/", validate(listSolicitudesQuerySchema, "query"), listOficina);
router.post("/:id/rechazar", validate(solicitudIdSchema, "params"), validate(rechazarSolicitudSchema), rechazar);

export default router;
