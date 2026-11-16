import { Router } from "express";
import rateLimit from "express-rate-limit";
import { accetta, condividi, elimina, pubAnnullo, pubRichiesta, pubScollega, pubServizio, pubVivo, reinvia, rifiuta, rigenera, stato } from "../controllers/collegamento.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { autenticaRemoto } from "../services/collegamento.service.js";
import { accettaSchema, annulloParamSchema, annulloRemotoSchema, condivisioneSchema, idParamSchema, richiestaRemotaSchema, servizioRemotoSchema, vivoRemotoSchema } from "../validators/collegamento.validator.js";

// API PUBLICA para las otras apps One Driver (servidor a servidor: sin JWT, sin sesion, sin CORS especial). Se monta en routes/index.js ANTES de
// rrhhGate/clienteGate/authenticate. No hay ningun GET: la otra app solo puede dejar solicitudes, no leer, editar ni borrar nada.
const limite = (opzioni) =>
  rateLimit({ windowMs: 15 * 60 * 1000, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Troppi tentativi, riprova più tardi" }, ...opzioni });
// /richiesta: quien prueba codigos (cada intento cuenta). Rutas con token: solo cuentan los FALLOS (el trafico normal entre las apps no se bloquea).
const limiteRichiesta = limite({ limit: 10 });
const limiteToken = limite({ limit: 30, skipSuccessfulRequests: true });

// /vivo (solo lectura, la pide Piazza cuando alguien mira): maximo 30 peticiones por minuto POR CONEXION (no por IP). Va despues de autenticaRemoto, asi que
// solo cuenta quien tiene un token valido.
const limiteVivo = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => `vivo:${req.params.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Troppe richieste, riprova tra poco" },
});

export const pubblico = Router();
pubblico.post("/richiesta", limiteRichiesta, validate(richiestaRemotaSchema), pubRichiesta);
pubblico.post("/:id/scollega", limiteToken, validate(idParamSchema, "params"), autenticaRemoto, pubScollega);
pubblico.post("/:id/servizi", limiteToken, validate(idParamSchema, "params"), autenticaRemoto, validate(servizioRemotoSchema), pubServizio);
pubblico.post("/:id/vivo", limiteToken, validate(idParamSchema, "params"), autenticaRemoto, limiteVivo, validate(vivoRemotoSchema), pubVivo);
pubblico.post("/:id/servizi/:recordId/annulla", limiteToken, validate(annulloParamSchema, "params"), autenticaRemoto, validate(annulloRemotoSchema), pubAnnullo);

// ---- Oficina ----
const router = Router();
router.use(authenticate);
// Volver a avisar a la otra app de una solicitud aceptada: quien gestiona los servicios (Owner y Admin/Responsables).
router.post("/solicitudes/:id/reinvia", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), reinvia);
// El codigo y las conexiones: solo el Owner.
router.get("/", authorize("OWNER"), stato);
router.post("/codice", authorize("OWNER"), rigenera);
router.post("/:id/accetta", authorize("OWNER"), validate(idParamSchema, "params"), validate(accettaSchema), accetta);
router.patch("/:id/condivisione", authorize("OWNER"), validate(idParamSchema, "params"), validate(condivisioneSchema), condividi);
router.post("/:id/rifiuta", authorize("OWNER"), validate(idParamSchema, "params"), rifiuta);
router.delete("/:id", authorize("OWNER"), validate(idParamSchema, "params"), elimina);

export default router;
