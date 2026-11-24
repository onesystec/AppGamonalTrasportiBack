import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const signToken = (payload) =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });

export const sessionLifetimeSeconds = (cargo) => {
  if (cargo === "CHOFER") return 2 * 60 * 60;
  if (["OWNER", "ADMIN", "RRHH"].includes(cargo)) return 12 * 60 * 60;
  return null;
};

export const signSessionToken = (user) => {
  const payload = { sub: user.id };
  const lifetime = sessionLifetimeSeconds(user.cargo);
  return lifetime === null ? signToken(payload) : jwt.sign(payload, env.JWT_SECRET, { expiresIn: lifetime, jwtid: randomUUID() });
};

export const verifyToken = (token) => jwt.verify(token, env.JWT_SECRET);

/** Ticket de OneSystec (single sign-on): firmado con la clave compartida, no con JWT_SECRET. Solo HS256. */
export const verifySsoTicket = (ticket, secret) => jwt.verify(ticket, secret, { algorithms: ["HS256"] });
