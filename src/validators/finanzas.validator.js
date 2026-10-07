import { z } from "zod";

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const month = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (usa AAAA-MM)")
    .optional()
);

export const monthQuerySchema = z.object({ month });

export const pagosQuerySchema = z.object({
  month,
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
});
