import { Router } from "express";
import { enVivo, exportar, fotos, me, ruta, seguimiento, servicios } from "../controllers/cliente.controller.js";
import { createCliente, listCliente, removeCliente, updateCliente } from "../controllers/solicitud.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { clienteMesQuerySchema, clienteServicioIdSchema } from "../validators/cliente.validator.js";
import { clienteSolicitudesQuerySchema, createSolicitudSchema, solicitudIdSchema, updateSolicitudSchema } from "../validators/solicitud.validator.js";

const router = Router();

// Usuarios de empresas cliente (solo lectura, siempre lo de su empresa). Cada ruta exige ademas su casilla de modulo.
router.use(authenticate, authorize("CLIENTE"));

router.get("/me", me);
router.get("/seguimiento", seguimiento);
router.get("/en-vivo", enVivo);
router.get("/seguimiento/:id/ruta", validate(clienteServicioIdSchema, "params"), ruta);
router.get("/servicios", validate(clienteMesQuerySchema, "query"), servicios);
router.get("/exportar", validate(clienteMesQuerySchema, "query"), exportar);
router.get("/servicios/:id/fotos", validate(clienteServicioIdSchema, "params"), fotos);

// Registro limitado: el cliente pide servicios a la oficina (modulo REGISTRO). Solo ve y toca sus solicitudes (y las de su empresa).
router.get("/solicitudes", validate(clienteSolicitudesQuerySchema, "query"), listCliente);
router.post("/solicitudes", validate(createSolicitudSchema), createCliente);
router.patch("/solicitudes/:id", validate(solicitudIdSchema, "params"), validate(updateSolicitudSchema), updateCliente);
router.delete("/solicitudes/:id", validate(solicitudIdSchema, "params"), removeCliente);

export default router;
