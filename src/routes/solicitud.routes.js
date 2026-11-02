import { Router } from "express";
import { crearDesdeTexto, leerTexto, listOficina, rechazar } from "../controllers/solicitud.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import {
  crearDesdeTextoSchema,
  leerTextoSchema,
  listSolicitudesQuerySchema,
  rechazarSolicitudSchema,
  solicitudIdSchema,
} from "../validators/solicitud.validator.js";

const router = Router();

// Solicitudes de servicio de los usuarios cliente (Piazza), vistas por la oficina. Aceptar = crear el servicio con `solicitudId` (POST /records).
router.use(authenticate, authorize("OWNER", "ADMIN"));

router.get("/", validate(listSolicitudesQuerySchema, "query"), listOficina);
// Servicio desde un texto pegado: el bot de reglas lo lee (sin guardar) y despues se crea la solicitud pendiente.
router.post("/leer-texto", validate(leerTextoSchema), leerTexto);
router.post("/desde-texto", validate(crearDesdeTextoSchema), crearDesdeTexto);
router.post("/:id/rechazar", validate(solicitudIdSchema, "params"), validate(rechazarSolicitudSchema), rechazar);

export default router;
