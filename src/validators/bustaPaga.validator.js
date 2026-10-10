import { z } from "zod";

export const idParamSchema = z.object({ id: z.string().uuid("Id invalido") });

export const uploadBustaPagaSchema = z.object({
  choferId: z.string().uuid("Chofer invalido"),
  anio: z.coerce.number().int().min(2000).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
});

export const listBustaPagaQuerySchema = z.object({
  choferId: z.string().uuid().optional(),
  anio: z.coerce.number().int().min(2000).max(2100).optional(),
  // "true": solo las propias (aunque quien consulta sea de la oficina o Recursos Humanos).
  propias: z.enum(["true", "false"]).optional(),
});

// La firma llega como imagen PNG en base64 (data URL) dibujada con el dedo en el celular.
export const signBustaPagaSchema = z.object({
  firma: z
    .string()
    .startsWith("data:image/png;base64,", "La firma debe ser una imagen PNG")
    .max(200_000, "La firma es demasiado grande"),
  acepto: z.literal(true, { errorMap: () => ({ message: "Debes confirmar que recibes la busta paga" }) }),
});
