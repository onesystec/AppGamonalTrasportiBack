import { z } from "zod";

export const AREA_VALUES = [
  "DHL_MILANO",
  "DHL_ROMA",
  "EXTRAS_PIAZZA_MILANO",
  "EXTRAS_PIAZZA_ROMA",
  "AB_SERVICE",
  "FARMACIA",
];

// Los formularios llegan como multipart: todo viene como string, y un campo opcional sin
// completar puede venir vacio.
const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const romeToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Fecha invalida");

const fechaNoFutura = dateOnly.refine((value) => value <= romeToday(), "La fecha no puede ser futura");

// Acepta "45,50" y "45.50"; siempre 2 decimales (es plata).
const monto = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim().replace(",", ".") : value),
    z.coerce
      .number({ invalid_type_error: "Monto invalido" })
      .positive("El monto debe ser mayor a 0")
      .max(99999999.99, "Monto demasiado alto")
  )
  .transform((value) => Math.round(value * 100) / 100);

const targa = z
  .string()
  .trim()
  .min(1, "La targa es obligatoria")
  .max(20)
  .transform((value) => value.replace(/\s+/g, "").toUpperCase());

const metodo = z.string().trim().min(1, "Indica la gasolinera").max(80);

const area = z.enum(AREA_VALUES, { errorMap: () => ({ message: "Elige un area valida" }) });

export const createCombustibleSchema = z.object({
  targa,
  // Solo lo usan OWNER/ADMIN; un CHOFER siempre queda como el chofer de su propio registro.
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
  monto,
  metodo,
  area,
  fecha: fechaNoFutura,
});

export const updateCombustibleSchema = z.object({
  targa: targa.optional(),
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
  monto: monto.optional(),
  metodo: metodo.optional(),
  area: area.optional(),
  fecha: fechaNoFutura.optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});

const rangeFilters = {
  from: z.preprocess(emptyToUndefined, dateOnly.optional()),
  to: z.preprocess(emptyToUndefined, dateOnly.optional()),
};

// Filtros que mueven tambien las estadisticas. El rango de fechas no: el resumen mensual
// y la serie siempre se miran por mes calendario.
const baseFilters = {
  driverId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  targa: z.preprocess(emptyToUndefined, z.string().trim().max(20).optional()),
  area: z.preprocess(emptyToUndefined, z.enum(AREA_VALUES).optional()),
  metodo: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
  q: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
};

const ORDEN_VALUES = ["recientes", "antiguos", "monto"];

export const listCombustibleQuerySchema = z.object({
  ...baseFilters,
  ...rangeFilters,
  orden: z.preprocess(emptyToUndefined, z.enum(ORDEN_VALUES).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const summaryCombustibleQuerySchema = z.object({ ...baseFilters, ...rangeFilters });

export const statsCombustibleQuerySchema = z.object(baseFilters);
