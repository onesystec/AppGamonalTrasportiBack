import { z } from "zod";

const CLASES = ["EN_CURSO", "SERVICIO", "COMBUSTIBLE", "TOLERADA", "A_REVISAR"];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida (AAAA-MM-DD)");

export const paradasQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
  // ?clase=A_REVISAR,COMBUSTIBLE
  clase: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").map((c) => c.trim()).filter(Boolean) : undefined))
    .refine((list) => !list || list.every((c) => CLASES.includes(c)), "Clase invalida"),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  recordId: z.string().uuid().optional(),
});
