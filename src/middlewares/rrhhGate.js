import { verifyToken } from "../utils/jwt.js";
import { findUserByIdForAuth } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// El acceso a cada acción de Finanzas se valida en su ruta y servicio.
const RRHH_ALLOWED_PREFIXES = [
  "/app", "/auth", "/users", "/documents", "/vehiculos", "/vencimientos", "/busta-paga", "/memorandums",
  "/finanzas", "/combustible", "/mancato-pagamentos", "/multas", "/solleciti", "/otros-gastos",
];

const RRHH_FINANCE_HOURS = /^\/horas\/[^/]+\/(revision|paradas|estimacion)\/?$/;

// Listas de Registros que se abren con el interruptor (nunca el detalle de un servicio, sus archivos, exportaciones ni nada que escriba).
const RRHH_REGISTROS_READ = [
  /^\/records\/?$/,
  /^\/records\/(pending|search|cambios)\/?$/,
  /^\/records\/\d{4}\/?$/,
  /^\/records\/\d{4}\/\d{1,2}\/?$/,
  /^\/records\/\d{4}\/\d{1,2}\/(summary|\d{1,2})\/?$/,
  /^\/clients\/?$/,
];

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
  if (req.method === "GET" && /^\/(horas\/pendientes|paradas(\/estado)?)\/?$/.test(req.path)) return next();
  if (req.method === "POST" && RRHH_FINANCE_HOURS.test(req.path)) return next();

  // Los Registros (solo las listas, solo lectura y sin importes) y la lista de clientes de sus filtros: solo si el Owner le activo el interruptor a esa persona.
  if (user.rrhhVeServicios && req.method === "GET" && RRHH_REGISTROS_READ.some((re) => re.test(req.path))) return next();
  throw new AppError("No tienes permisos para realizar esta accion", 403);
});
