import {
  loginUser,
  registerUser,
  requestPasswordReset,
  resetPassword,
  ssoLoginUser,
} from "../services/auth.service.js";
import { toUserResponse } from "../services/user.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const register = asyncHandler(async (req, res) => {
  const { user, token } = await registerUser(req.body);
  res.status(201).json({ success: true, data: { user, token } });
});

export const login = asyncHandler(async (req, res) => {
  const { user, token } = await loginUser(req.body);
  res.status(200).json({ success: true, data: { user, token } });
});

export const sso = asyncHandler(async (req, res) => {
  const { user, accessToken } = await ssoLoginUser(req.body.ticket);
  res.status(200).json({ success: true, data: { user, accessToken } });
});

export const me = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { user: await toUserResponse(req.realUser ?? req.user) } });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  await requestPasswordReset(req.body.correoElectronico);
  res.status(200).json({
    success: true,
    message: "Si el correo existe, se envio un enlace para restablecer la contrasena",
  });
});

export const resetPasswordHandler = asyncHandler(async (req, res) => {
  await resetPassword(req.body.token, req.body.newPassword);
  res.status(200).json({ success: true, message: "Contrasena actualizada correctamente" });
});
