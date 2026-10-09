import { verifyToken } from "../utils/jwt.js";
import { findUserByIdForAuth } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Recursos Humanos solo puede usar estas partes de la API (lo demas, incluido todo lo financiero y los
// servicios, se le niega aqui sin depender de cada ruta). Dentro de /users, /documents y /vehiculos los
// servicios aplican ademas sus propios limites (solo choferes, sin mantenimiento ni posiciones en vivo).
const RRHH_ALLOWED_PREFIXES = ["/auth", "/users", "/documents", "/vehiculos", "/busta-paga"];

export const rrhhGate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();

  let payload;
  try {
    payload = verifyToken(header.slice("Bearer ".length));
  } catch {
    return next(); // el token malo lo rechaza authenticate en cada ruta
  }

  const user = await findUserByIdForAuth(payload.sub);
  if (user?.cargo !== "RRHH") return next();

  if (RRHH_ALLOWED_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
  throw new AppError("No tienes permisos para realizar esta accion", 403);
});
