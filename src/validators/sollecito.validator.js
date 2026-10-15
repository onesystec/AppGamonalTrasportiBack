import { z } from "zod";

const ESTADOS = ["POR_PAGAR", "PAGADO", "NO_CORRESPONDE"];

// Los formularios llegan como multipart: todo viene como string y un campo opcional vacio llega "".
const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const emptyToNull = (value) => (typeof value === "string" && value.trim() === "" ? null : value);

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Fecha invalida");

const importe = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim().replace(",", ".") : value),
    z.coerce.number({ invalid_type_error: "Importe invalido" }).min(0, "Importe invalido").max(99999999.99)
  )
  .transform((value) => Math.round(value * 100) / 100);

const targa = z
  .string()
  .trim()
  .max(20)
  .transform((value) => value.replace(/\s+/g, "").toUpperCase());

// "3195086644, 3195086645" o un array -> ["3195086644", "3195086645"]
const numerosMancato = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}, z.array(z.string().max(40)).max(50));

const base = {
  emisor: z.string().trim().min(1, "El emisor es obligatorio").max(120),
  numeroAtto: z.string().trim().min(1, "El numero de atto es obligatorio").max(60),
  fechaCarta: z.preprocess(emptyToUndefined, dateOnly.optional()),
  fechaTransito: z.preprocess(emptyToUndefined, dateOnly.optional()),
  targa: z.preprocess(emptyToUndefined, targa.optional()),
  numerosMancato: z.preprocess(emptyToUndefined, numerosMancato.optional()),
  importe: z.preprocess(emptyToUndefined, importe.optional()),
  sitioPago: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
  estado: z.preprocess(emptyToUndefined, z.enum(ESTADOS).optional()),
  comentarios: z.preprocess(emptyToUndefined, z.string().trim().max(2000).optional()),
};

export const createSollecitoSchema = z.object(base);

// En la edicion un campo vacio borra el valor (salvo emisor y atto, que son obligatorios).
export const updateSollecitoSchema = z.object({
  emisor: base.emisor.optional(),
  numeroAtto: base.numeroAtto.optional(),
  fechaCarta: z.preprocess(emptyToNull, dateOnly.nullable().optional()),
  fechaTransito: z.preprocess(emptyToNull, dateOnly.nullable().optional()),
  targa: z.preprocess(emptyToNull, targa.nullable().optional()),
  numerosMancato: z.preprocess((v) => (v === "" ? [] : v), numerosMancato.optional()),
  importe: z.preprocess(emptyToNull, importe.nullable().optional()),
  sitioPago: z.preprocess(emptyToNull, z.string().trim().max(500).nullable().optional()),
  estado: base.estado,
  comentarios: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
});

export const listSollecitiQuerySchema = z.object({
  estado: z.preprocess(emptyToUndefined, z.enum(ESTADOS).optional()),
  q: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  from: z.preprocess(emptyToUndefined, dateOnly.optional()),
  to: z.preprocess(emptyToUndefined, dateOnly.optional()),
});

export const idParamSchema = z.object({ id: z.string().uuid("Id invalido") });
