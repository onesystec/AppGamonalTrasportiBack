import { z } from "zod";

const AREA_VALUES = ["EXTRAS_PIAZZA", "DHL", "FARMACIA"];

const passwordSchema = z
  .string()
  .min(8, "La contrasena debe tener al menos 8 caracteres");

export const registerSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  apellido: z.string().trim().min(1, "El apellido es obligatorio"),
  area: z.enum(AREA_VALUES, { errorMap: () => ({ message: "Area invalida" }) }),
  fechaNacimiento: z.coerce.date({ errorMap: () => ({ message: "Fecha de nacimiento invalida" }) }),
  numeroCelular: z.string().trim().min(6, "Numero de celular invalido"),
  correoElectronico: z.string().trim().email("Correo electronico invalido"),
  password: passwordSchema,
});

export const loginSchema = z.object({
  correoElectronico: z.string().trim().email("Correo electronico invalido"),
  password: z.string().min(1, "La contrasena es obligatoria"),
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
