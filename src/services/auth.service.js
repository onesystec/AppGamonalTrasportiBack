import { env } from "../config/env.js";
import { resend } from "../config/resend.js";
import {
  findUserByEmail,
  findUserByEmailWithPassword,
  findUserById,
  findUserByValidResetToken,
  resetPasswordAndClearToken,
  setResetToken,
} from "../models/user.model.js";
import { buildResetPasswordEmail } from "../emails/resetPasswordEmail.js";
import { toUserResponse } from "./user.service.js";
import { AppError } from "../utils/AppError.js";
import { signToken, verifySsoTicket } from "../utils/jwt.js";
import { comparePassword, hashPassword } from "../utils/password.js";
import { generateResetToken, hashResetToken } from "../utils/resetToken.js";

const GENERIC_LOGIN_ERROR = "Correo electronico o contrasena incorrectos";

// Hash de una clave que nadie conoce: cuando el correo no existe se compara contra este, para que responder tarde lo mismo que con un
// correo real y no se pueda saber por el tiempo (12 ms contra 140 ms) que cuentas existen.
const DUMMY_HASH = "$2b$12$bo9b1O3oAT6muvrq0BPqqOxj4ViWMYXj5zE8IY.kPVmuseMCkagq.";

export const loginUser = async ({ correoElectronico, password }) => {
  const user = await findUserByEmailWithPassword(correoElectronico);

  const isPasswordValid = await comparePassword(password, user?.password ?? DUMMY_HASH);

  if (!user || !isPasswordValid) {
    throw new AppError(GENERIC_LOGIN_ERROR, 401);
  }

  // Recien con la clave correcta se dice que la cuenta esta inactiva: antes, ese mensaje confirmaba que el correo existe sin saber la clave.
  if (user.estado === "INACTIVO") {
    throw new AppError("Tu cuenta esta inactiva. Contacta a un administrador.", 403);
  }

  const token = signToken({ sub: user.id });
  const safeUser = await findUserById(user.id);

  return { user: await toUserResponse(safeUser), token };
};

// Productos de OneSystec que entran a esta plataforma (Driver y Farmacy comparten backend).
const SSO_PRODUCTS = ["driver", "farmacy"];
const SSO_MAX_TICKET_SECONDS = 5 * 60;

/**
 * Acceso directo desde OneSystec: el ticket solo prueba que ese correo acaba de iniciar sesion alla.
 * Se cambia por una sesion normal de esta app si el correo corresponde a un usuario activo.
 */
export const ssoLoginUser = async (ticket) => {
  if (!env.SSO_SHARED_SECRET) {
    throw new AppError("El acceso directo no esta configurado", 503);
  }

  let claims;
  try {
    claims = verifySsoTicket(ticket, env.SSO_SHARED_SECRET);
  } catch {
    throw new AppError("Ticket invalido o vencido", 401);
  }
  // El ticket debe vencer y vivir poco (OneSystec lo emite por 60 s): sin "exp" valdria para siempre y se podria reusar.
  const lifetime = Number(claims.exp) - Number(claims.iat ?? Math.floor(Date.now() / 1000));
  if (!Number.isFinite(lifetime) || lifetime > SSO_MAX_TICKET_SECONDS) {
    throw new AppError("Ticket invalido o vencido", 401);
  }
  if (typeof claims.email !== "string" || !SSO_PRODUCTS.includes(claims.product)) {
    throw new AppError("Ticket invalido o vencido", 401);
  }

  const user = await findUserByEmail(claims.email);
  if (!user) {
    throw new AppError("Tu correo no tiene una cuenta en esta plataforma. Contacta a un administrador.", 403);
  }
  if (user.estado === "INACTIVO") {
    throw new AppError("Tu cuenta esta inactiva. Contacta a un administrador.", 403);
  }

  return { user: await toUserResponse(user), accessToken: signToken({ sub: user.id }) };
};

export const requestPasswordReset = async (correoElectronico) => {
  const user = await findUserByEmail(correoElectronico);

  // Si el usuario no existe, no se hace nada, pero tampoco se informa al llamador
  // (el controller siempre responde el mismo mensaje generico para evitar enumeracion de correos).
  if (!user) return;

  const { rawToken, hashedToken } = generateResetToken();
  const expiresAt = new Date(Date.now() + env.RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000);

  await setResetToken(user.id, hashedToken, expiresAt);

  const { subject, html } = buildResetPasswordEmail({ nombre: user.nombre, rawToken });

  await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: user.correoElectronico,
    subject,
    html,
  });
};

export const resetPassword = async (token, newPassword) => {
  const hashedToken = hashResetToken(token);
  const user = await findUserByValidResetToken(hashedToken);

  if (!user) {
    throw new AppError("El token es invalido o ya expiro", 400);
  }

  const hashedPassword = await hashPassword(newPassword);
  return resetPasswordAndClearToken(user.id, hashedPassword);
};
