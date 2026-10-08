import { z } from "zod";

const ESTADO_VALUES = ["PENDIENTE", "PAGADO", "VENCIDO"];

// Los formularios llegan como multipart: todo viene como string, y un campo opcional sin
// completar puede venir vacio.
const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const emptyToNull = (value) => (typeof value === "string" && value.trim() === "" ? null : value);

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

// Texto libre (puede ser una direccion web o cualquier indicacion de donde pagar).
const sitioWeb = z.string().trim().max(500);

const targa = z
  .string()
  .trim()
  .min(1, "La targa es obligatoria")
  .max(20)
  .transform((value) => value.replace(/\s+/g, "").toUpperCase());

const numero = z
  .string()
  .trim()
  .min(1, "El numero de mancato pagamento es obligatorio")
  .max(60)
  .transform((value) => value.toUpperCase());

// Hora del transito (la que dice el aviso), en hora de Roma.
const hora = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora invalida (usa HH:MM)");

const ASIGNACION_VALUES = [
  "AUTO",
  "SUGERIDO",
  "CONFIRMADO",
  "MANUAL",
  "EN_ESPERA",
  "FUERA_DE_HORARIO",
  "REVISAR",
];

export const createMancatoSchema = z.object({
  numero,
  hora,
  targa,
  // Solo lo usan OWNER/ADMIN; un CHOFER siempre queda como el chofer de su propio mancato.
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
  fecha: dateOnly.refine((value) => value <= romeToday(), "La fecha no puede ser futura"),
  costo,
  sitioWeb: z.preprocess(emptyToUndefined, sitioWeb.optional()),
  comentarios: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
});

// "" borra el campo (null); ausente no lo toca.
export const updateMancatoSchema = z.object({
  numero: numero.optional(),
  hora: hora.optional(),
  // Solo OWNER/ADMIN: servicio elegido a mano ("" lo deja fuera del horario laboral) o
  // confirmar el que propuso el sistema.
  recordId: z.preprocess(emptyToNull, z.string().uuid("Servicio invalido").nullable().optional()),
  confirmar: z.enum(["true"]).optional(),
  targa: targa.optional(),
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
  fecha: dateOnly.refine((value) => value <= romeToday(), "La fecha no puede ser futura").optional(),
  costo: costo.optional(),
  sitioWeb: z.preprocess(emptyToNull, sitioWeb.nullable().optional()),
  comentarios: z.preprocess(emptyToNull, z.string().trim().max(1000).nullable().optional()),
  pagado: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
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
  fueraDePlazo: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
  // REVISAR = lo que la oficina debe mirar: sugeridos + en espera de servicio.
  asignacion: z.preprocess(emptyToUndefined, z.enum(ASIGNACION_VALUES).optional()),
};

const ORDEN_VALUES = ["urgencia", "recientes", "antiguos", "monto"];

export const listMancatosQuerySchema = z.object({
  ...listFilters,
  estado: z.preprocess(emptyToUndefined, z.enum(ESTADO_VALUES).optional()),
  orden: z.preprocess(emptyToUndefined, z.enum(ORDEN_VALUES).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const summaryMancatosQuerySchema = z.object(listFilters);

// Mismos filtros que el resumen: las estadisticas acompanan lo que se esta filtrando.
export const statsMancatosQuerySchema = z.object(listFilters);
