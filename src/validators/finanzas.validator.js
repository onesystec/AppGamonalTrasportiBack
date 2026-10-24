import { z } from "zod";
import { AREA_KEYS } from "../constants/areas.js";

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const month = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (usa AAAA-MM)")
    .optional()
);

// Ranking de km: el mes en curso o la semana en curso (lunes a hoy).
export const rankingKmQuerySchema = z.object({
  periodo: z.preprocess(emptyToUndefined, z.enum(["mes", "semana"]).default("mes")),
  // Solo los servicios de esa zona (como el filtro de Resumen semanal).
  zona: z.preprocess(emptyToUndefined, z.enum(["MILANO", "ROMA"]).optional()),
  // Solo esas areas (claves separadas por coma, p. ej. "piazza-milano,dhl-roma"); sin esto, las 5 principales (sin "Otros").
  areas: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? v.split(",").map((k) => k.trim()) : undefined),
    z.array(z.enum(AREA_KEYS)).optional()
  ),
});

export const monthQuerySchema = z.object({ month });

export const pagosQuerySchema = z.object({
  month,
  driverId: z.preprocess(emptyToUndefined, z.string().uuid("Chofer invalido").optional()),
});

// Planilla de presencias del mes: horas como decimal (6,68) o como horas:minutos (6:41).
export const presenciasQuerySchema = z.object({
  month,
  formato: z.preprocess(emptyToUndefined, z.enum(["decimal", "hhmm"]).default("decimal")),
});

// Velocidad de pago de un chofer en un mes (85, 90 o 95 km/h).
export const velocidadPagoSchema = z.object({
  driverId: z.string().uuid("Chofer invalido"),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (usa AAAA-MM)"),
  kmh: z.coerce.number().int("Velocidad invalida").refine((v) => [85, 90, 95].includes(v), "La velocidad tiene que ser 85, 90 o 95 km/h"),
});

// Tarifas por km (EUR/km): cualquiera de las categorias de vehiculo o la de DHL/AB Service.
const tarifa = z.coerce.number({ invalid_type_error: "Tarifa invalida" }).min(0, "La tarifa no puede ser negativa").max(100, "Tarifa invalida");
export const tarifasKmSchema = z.object({
  AUTO_FURGONCINO: tarifa.optional(),
  H1_L1: tarifa.optional(),
  H2_L2: tarifa.optional(),
  CASONATO: tarifa.optional(),
  DHL_AB: tarifa.optional(),
});
