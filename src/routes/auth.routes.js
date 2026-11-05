import { Router } from "express";
import rateLimit from "express-rate-limit";
import { forgotPassword, login, me, resetPasswordHandler, sso } from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { validate } from "../middlewares/validate.js";
import { forgotPasswordSchema, loginSchema, resetPasswordSchema, ssoSchema } from "../validators/auth.validator.js";

const router = Router();

// El registro publico esta desactivado a proposito: las cuentas las crea la oficina (POST /api/users). Cualquier cuenta
// autoregistrada era un acceso al sistema sin que nadie lo aprobara.

// Un limitador por ruta (antes compartian un solo contador) y detras del proxy de Render la IP real llega por "trust proxy" (ver app.js).
const limiter = ({ windowMs = 15 * 60 * 1000, limit, keyGenerator, skipSuccessfulRequests = false }) =>
  rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Demasiados intentos, intenta de nuevo mas tarde" },
  });

// Login: por IP (barrido de muchas cuentas) y por IP + correo (fuerza bruta contra una cuenta). Los logins correctos no cuentan.
const loginByIp = limiter({ limit: 40, skipSuccessfulRequests: true });
const loginByIpAndEmail = limiter({
  limit: 8,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.correoElectronico ?? "").trim().toLowerCase()}`,
});
const forgotLimiter = limiter({ limit: 10 });
const resetLimiter = limiter({ limit: 20 });
const ssoLimiter = limiter({ limit: 40 });

router.post("/login", loginByIp, validate(loginSchema), loginByIpAndEmail, login);
router.post("/sso", ssoLimiter, validate(ssoSchema), sso);
router.get("/me", authenticate, me);
router.post("/forgot-password", forgotLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post("/reset-password", resetLimiter, validate(resetPasswordSchema), resetPasswordHandler);

export default router;
