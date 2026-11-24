import { isDriverMode } from "../utils/modoChofer.js";
import { sessionLifetimeSeconds, verifyToken } from "../utils/jwt.js";
import { findUserByIdForAuth } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const authenticate = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError("No autenticado: token no proporcionado", 401);
  }

  const token = authHeader.slice("Bearer ".length);

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new AppError("No autenticado: token invalido o expirado", 401);
  }

  // Se vuelve a leer el usuario en cada request (en vez de confiar solo en el payload)
  // para que un usuario desactivado pierda el acceso de inmediato, sin esperar a que expire
  // el token. Sale de una cache en memoria de pocos minutos que se invalida en cada
  // escritura sobre el usuario (ver findUserByIdForAuth), para no consultar Postgres en
  // cada pedido - eso lo mantiene despierto en Neon.
  const { passwordChangedAt, ...user } = (await findUserByIdForAuth(payload.sub)) ?? {};

  if (!user.id) {
    throw new AppError("No autenticado: el usuario ya no existe", 401);
  }

  // Un token emitido antes del ultimo cambio de contrasena ya no vale (se compara en segundos, que es lo que trae "iat").
  if (passwordChangedAt && (payload.iat ?? 0) < Math.floor(passwordChangedAt.getTime() / 1000)) {
    throw new AppError("No autenticado: la sesion se cerro al cambiar la contrasena", 401);
  }

  if (user.estado === "INACTIVO") {
    throw new AppError("Tu cuenta esta inactiva. Contacta a un administrador.", 403);
  }

  const lifetime = sessionLifetimeSeconds(user.cargo);
  if (lifetime !== null && (!payload.iat || Math.floor(Date.now() / 1000) >= payload.iat + lifetime)) {
    throw new AppError("No autenticado: la sesion ha expirado", 401);
  }

  // Modo chofer: la oficina que activa el switch en la app pide ver todo como un chofer (sus servicios, sus horas, sus
  // cargos). Solo baja permisos: para cualquier otro cargo el header se ignora. req.realUser conserva al usuario de verdad.
  const asDriver = isDriverMode(req, user);
  req.realUser = user;
  req.user = asDriver ? { ...user, cargo: "CHOFER" } : user;
  next();
});
