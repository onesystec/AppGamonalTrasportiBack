import { z } from "zod";

// bcrypt solo usa los primeros 72 bytes: un tope evita contrasenas enormes (costo de CPU) y que parezcan mas largas de lo que son.
const passwordSchema = z
  .string()
  .min(8, "La contrasena debe tener al menos 8 caracteres")
  .max(72, "La contrasena no puede superar los 72 caracteres");

export const loginSchema = z.object({
  correoElectronico: z.string().trim().email("Correo electronico invalido"),
  password: z.string().min(1, "La contrasena es obligatoria").max(200, "Contrasena invalida"),
});

export const forgotPasswordSchema = z.object({
  correoElectronico: z.string().trim().email("Correo electronico invalido"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "El token es obligatorio"),
  newPassword: passwordSchema,
});

export const ssoSchema = z.object({
  ticket: z.string().trim().min(1, "El ticket es obligatorio"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Escribe tu contrasena actual").max(200, "Contrasena invalida"),
  newPassword: passwordSchema,
});
