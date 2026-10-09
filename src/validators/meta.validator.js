import { z } from "zod";

const meta = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.coerce.number().min(0).max(100000).nullable());

export const metasConfigSchema = z.object({
  NOVATO: meta.optional(),
  MASTER: meta.optional(),
  SENIOR: meta.optional(),
});

export const progressQuerySchema = z.object({
  month: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (AAAA-MM)").optional()
  ),
});
