import { env } from "../config/env.js";
import { resend } from "../config/resend.js";
import {
  createUser,
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

export const registerUser = async (data) => {
  const hashedPassword = await hashPassword(data.password);

  // El cargo y el estado nunca se toman del cliente en el registro publico:
  // se fuerzan aqui para evitar que alguien se autoasigne un rol privilegiado.
  const user = await createUser({
    nombre: data.nombre,
    apellido: data.apellido,
    area: data.area,
    fechaNacimiento: data.fechaNacimiento,
    numeroCelular: data.numeroCelular,
    correoElectronico: data.correoElectronico,
    password: hashedPassword,
    cargo: "CHOFER",
    estado: "ACTIVO",
  });

  const token = signToken({ sub: user.id });

  return { user: await toUserResponse(user), token };
};

export const loginUser = async ({ correoElectronico, password }) => {
  const user = await findUserByEmailWithPassword(correoElectronico);

  if (!user) {
    throw new AppError(GENERIC_LOGIN_ERROR, 401);
  }

  if (user.estado === "INACTIVO") {
    throw new AppError("Tu cuenta esta inactiva. Contacta a un administrador.", 403);
  }

  const isPasswordValid = await comparePassword(password, user.password);

  if (!isPasswordValid) {
    throw new AppError(GENERIC_LOGIN_ERROR, 401);
  }

  const token = signToken({ sub: user.id });
  const safeUser = await findUserById(user.id);

  return { user: await toUserResponse(safeUser), token };
};

// Productos de OneSystec que entran a esta plataforma (Driver y Farmacy comparten backend).
const SSO_PRODUCTS = ["driver", "farmacy"];

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
