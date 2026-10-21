import { z } from "zod";

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const clienteMesQuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (usa AAAA-MM)").optional()),
});

export const clienteServicioIdSchema = z.object({ id: z.string().uuid("Id invalido") });
