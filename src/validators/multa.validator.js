import { z } from "zod";
import { AREA_KEYS } from "../constants/areas.js";

const ESTADO_VALUES = ["PENDIENTE", "PAGADO", "VENCIDO"];
const QUIEN_PAGA_VALUES = ["CHOFER_PAGO", "A_DESCONTAR"];
const ORDEN_VALUES = ["urgencia", "recientes", "antiguos", "monto"];

// Los formularios llegan como multipart: todo viene como string, y un campo opcional sin
// completar puede venir vacio.
const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const emptyToNull = (value) => (typeof value === "string" && value.trim() === "" ? null : value);
const boolString = z.enum(["true", "false"]).transform((value) => value === "true");

const romeToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Fecha invalida");

// Acepta "12,50" y "12.50"; siempre 2 decimales (es plata).
const costo = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim().replace(",", ".") : value),
    z.coerce
      .number({ invalid_type_error: "Costo invalido" })
      .positive("El costo debe ser mayor a 0")
      .max(99999999.99, "Costo demasiado alto")
  )
  .transform((value) => Math.round(value * 100) / 100);

const targa = z
  .string()
  .trim()
  .min(1, "La targa es obligatoria")
  .max(20)
  .transform((value) => value.replace(/\s+/g, "").toUpperCase());

const numeroVerbale = z
  .string()
  .trim()
  .min(1, "El numero de verbale es obligatorio")
  .max(60)
  .transform((value) => value.toUpperCase());

const quienPaga = z.enum(QUIEN_PAGA_VALUES, { errorMap: () => ({ message: "Indica si pago el chofer o se descuenta" }) });

export const createMultaSchema = z.object({
  numeroVerbale,
  targa,
  driverId: z.string().uuid("Elige el chofer responsable"),
  // Dia de la infraccion (opcional): sirve para saber quien llevaba el vehiculo ese dia.
  fechaInfraccion: z.preprocess(
    emptyToUndefined,
    dateOnly.refine((value) => value <= romeToday(), "La fecha de la infraccion no puede ser futura").optional()
  ),
  fechaRecepcion: dateOnly.refine((value) => value <= romeToday(), "La fecha de recepcion no puede ser futura"),
  // El verbale trae su propio vencimiento; si no se manda, se usa recepcion + 60 dias.
  fechaVencimiento: z.preprocess(emptyToUndefined, dateOnly.optional()),
  costo,
  quienPaga,
  // Area de servicio a la que se imputa (ver User.areasPermitidas). Un Responsable debe indicarla.
  area: z.preprocess(emptyToUndefined, z.enum(AREA_KEYS).optional()),
  comentarios: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
});

// "" borra los textos opcionales (null); ausente no toca el campo.
export const updateMultaSchema = z.object({
  numeroVerbale: numeroVerbale.optional(),
  targa: targa.optional(),
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
  // "" borra la fecha de infraccion (null).
  fechaInfraccion: z.preprocess(
    emptyToNull,
    dateOnly.refine((value) => value <= romeToday(), "La fecha de la infraccion no puede ser futura").nullable().optional()
  ),
  fechaRecepcion: dateOnly.refine((value) => value <= romeToday(), "La fecha de recepcion no puede ser futura").optional(),
  fechaVencimiento: z.preprocess(emptyToUndefined, dateOnly.optional()),
  costo: costo.optional(),
  quienPaga: quienPaga.optional(),
  area: z.preprocess(emptyToNull, z.enum(AREA_KEYS).nullable().optional()),
  comentarios: z.preprocess(emptyToNull, z.string().trim().max(1000).nullable().optional()),
  pagado: boolString.optional(),
  descontado: boolString.optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});

const listFilters = {
  driverId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  targa: z.preprocess(emptyToUndefined, z.string().trim().max(20).optional()),
  q: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  from: z.preprocess(emptyToUndefined, dateOnly.optional()),
  to: z.preprocess(emptyToUndefined, dateOnly.optional()),
  quienPaga: z.preprocess(emptyToUndefined, z.enum(QUIEN_PAGA_VALUES).optional()),
  // "true": solo las que hay que descontar y todavia no se descontaron.
  descuentoPendiente: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
};

export const listMultasQuerySchema = z.object({
  ...listFilters,
  estado: z.preprocess(emptyToUndefined, z.enum(ESTADO_VALUES).optional()),
  orden: z.preprocess(emptyToUndefined, z.enum(ORDEN_VALUES).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const summaryMultasQuerySchema = z.object(listFilters);
export const statsMultasQuerySchema = z.object(listFilters);

// Sugerencia de chofer: quien llevaba esa unidad el dia de la infraccion.
export const suggestDriverQuerySchema = z.object({
  targa,
  fecha: dateOnly,
});
