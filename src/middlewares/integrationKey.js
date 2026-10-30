import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

// Clave de servicio de OneSystec (solo lectura, ver routes/integracionOnesystec.routes.js). Viaja en "X-Integration-Key" y no en
// "Authorization" para no confundirse con la sesion de una persona. Se compara en tiempo constante.
const sameKey = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const requireIntegrationKey = (req, _res, next) => {
  if (!env.ONESYSTEC_INTEGRATION_KEY) return next(new AppError("La integracion con OneSystec no esta configurada", 503));
  const given = req.headers["x-integration-key"];
  if (typeof given !== "string" || !sameKey(given, env.ONESYSTEC_INTEGRATION_KEY)) {
    return next(new AppError("No autenticado: clave de integracion invalida", 401));
  }
  next();
};
