import { verifyToken } from "../utils/jwt.js";
import { findUserByIdForAuth } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Un usuario CLIENTE solo puede usar estas partes de la API (todo lo demas se le niega aca, sin depender de cada ruta):
//  - /cliente: su seguimiento, historial y fotos (siempre filtrado por su empresa, ver services/cliente.service.js).
//  - /auth y /app: iniciar sesion, su sesion actual y la version de la app.
//  - /users/me/push-token: registrar y quitar el celular para los avisos.
const CLIENTE_ALLOWED_PREFIXES = ["/cliente", "/auth", "/app", "/users/me/push-token"];

export const clienteGate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();

  let payload;
  try {
    payload = verifyToken(header.slice("Bearer ".length));
  } catch {
    return next(); // el token malo lo rechaza authenticate en cada ruta
  }

  const user = await findUserByIdForAuth(payload.sub);
  if (user?.cargo !== "CLIENTE") return next();

  if (CLIENTE_ALLOWED_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
  throw new AppError("No tienes permisos para realizar esta accion", 403);
});
