import { z } from "zod";

export const createClientSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  serviciosDirectos: z.boolean().optional(),
});

export const updateClientSchema = z
  .object({
    nombre: z.string().trim().min(1, "El nombre es obligatorio").optional(),
    serviciosDirectos: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No hay nada que cambiar" });

export const idParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});
