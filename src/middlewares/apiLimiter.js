import rateLimit from "express-rate-limit";
import { verifyToken } from "../utils/jwt.js";

// Limite GENERAL de peticiones a la API (el login y las rutas de contrasena ya tienen el suyo, mas estricto, en auth.routes.js).
//  - Con sesion valida se cuenta POR USUARIO, no por IP: varios choferes en el mismo Wi-Fi (deposito, oficina) no se gastan el limite entre si.
//  - Sin sesion, o con un token falso, se cuenta por IP: asi inventar tokens distintos no esquiva el limite.
// Los topes son holgados a proposito (la app consulta seguido: mapa, GPS, avisos); solo cortan bucles y abusos.
const USER_LIMIT_PER_MIN = 600;
const ANON_LIMIT_PER_MIN = 120;

// Rutas con su propia autenticacion o que reciben rafagas legitimas de servicios externos.
const EXEMPT_PREFIXES = ["/api/health", "/api/telegram/", "/api/integraciones/", "/api/app/android/publicar"];

const identify = (req) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const { sub } = verifyToken(header.slice("Bearer ".length));
      if (typeof sub === "string" && sub) return { key: `u:${sub}`, limit: USER_LIMIT_PER_MIN };
    } catch {
      // token invalido: se trata como anonimo (por IP)
    }
  }
  return { key: `ip:${req.ip}`, limit: ANON_LIMIT_PER_MIN };
};

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (req._rl ??= identify(req)).limit,
  keyGenerator: (req) => (req._rl ??= identify(req)).key,
  skip: (req) => req.method === "OPTIONS" || EXEMPT_PREFIXES.some((p) => req.originalUrl.startsWith(p)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Demasiadas peticiones, espera un momento e intenta de nuevo" },
});
