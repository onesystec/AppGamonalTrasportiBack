import { Router } from "express";
import { disponibilidad, editarCelda, enVivo, exportar, fotos, guardarHojaAnchos, hojaAnchos, me, ruta, seguimiento, servicios } from "../controllers/cliente.controller.js";
import { createCliente, detalleCliente, leerTextoDelCliente, listCliente, registrarDesdeTextoDelCliente, removeCliente, updateCliente } from "../controllers/solicitud.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { clienteMesQuerySchema, clienteServicioIdSchema, editarCeldaSchema, hojaAnchosBodySchema, hojaAnchosParamsSchema } from "../validators/cliente.validator.js";
import { disponibilidadQuerySchema } from "../validators/disponibilidad.validator.js";
import { clienteSolicitudesQuerySchema, createSolicitudSchema, leerTextoSchema, registrarDesdeTextoClienteSchema, solicitudIdSchema, updateSolicitudSchema } from "../validators/solicitud.validator.js";

const router = Router();

// Usuarios de empresas cliente (solo lectura, siempre lo de su empresa). Cada ruta exige ademas su casilla de modulo.
router.use(authenticate, authorize("CLIENTE"));

router.get("/me", me);
router.get("/seguimiento", seguimiento);
router.get("/en-vivo", enVivo);
router.get("/disponibilidad", validate(disponibilidadQuerySchema, "query"), disponibilidad);
router.get("/seguimiento/:id/ruta", validate(clienteServicioIdSchema, "params"), ruta);
router.get("/servicios", validate(clienteMesQuerySchema, "query"), servicios);
router.get("/exportar", validate(clienteMesQuerySchema, "query"), exportar);
// Editar una celda de la hoja tipo Excel (modulo REGISTRO): solicitud pendiente o servicio ya creado (con limites; ver cambioCelda.service.js).
router.patch("/celda", validate(editarCeldaSchema), editarCelda);
// Ancho de las columnas de las hojas tipo Excel (se guarda para todos los usuarios de la empresa).
router.get("/hoja-anchos", hojaAnchos);
router.put("/hoja-anchos/:hoja", validate(hojaAnchosParamsSchema, "params"), validate(hojaAnchosBodySchema), guardarHojaAnchos);
router.get("/servicios/:id/fotos", validate(clienteServicioIdSchema, "params"), fotos);

// Registro limitado: el cliente pide servicios a la oficina (modulo REGISTRO). Solo ve y toca sus solicitudes (y las de su empresa).
router.get("/solicitudes", validate(clienteSolicitudesQuerySchema, "query"), listCliente);
router.post("/solicitudes", validate(createSolicitudSchema), createCliente);
// Leer el texto del portal de DHL (o el mensaje interno) para rellenar la solicitud, y el detalle de una solicitud ya aceptada (chofer, targa, bolla).
// Registrar un servicio pegando solo el texto: se lee y se crea la solicitud de una vez.
router.post("/solicitudes/desde-texto", validate(registrarDesdeTextoClienteSchema), registrarDesdeTextoDelCliente);
router.post("/solicitudes/leer-texto", validate(leerTextoSchema), leerTextoDelCliente);
router.get("/solicitudes/:id/detalle", validate(solicitudIdSchema, "params"), detalleCliente);
router.patch("/solicitudes/:id", validate(solicitudIdSchema, "params"), validate(updateSolicitudSchema), updateCliente);
router.delete("/solicitudes/:id", validate(solicitudIdSchema, "params"), removeCliente);

export default router;
