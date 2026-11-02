import { z } from "zod";

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const clienteMesQuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (usa AAAA-MM)").optional()),
});

export const clienteServicioIdSchema = z.object({ id: z.string().uuid("Id invalido") });

// Ancho de las columnas de las hojas tipo Excel: { hoja } en la ruta y { anchos: { A: 120, ... } } (px) en el cuerpo.
export const hojaAnchosParamsSchema = z.object({ hoja: z.enum(["dhl", "roma", "ab", "extra"], { errorMap: () => ({ message: "Hoja invalida" }) }) });
export const hojaAnchosBodySchema = z.object({
  anchos: z
    .record(z.string().regex(/^[A-Z]$/, "Columna invalida"), z.coerce.number().int("Ancho invalido").min(30, "Ancho demasiado chico").max(800, "Ancho demasiado grande"))
    .refine((v) => Object.keys(v).length <= 10, { message: "Demasiadas columnas" }),
});
