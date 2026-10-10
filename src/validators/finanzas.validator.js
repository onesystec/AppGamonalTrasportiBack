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

// Tarifas por km (EUR/km): cualquiera de las categorias de vehiculo o la de DHL/AB Service.
const tarifa = z.coerce.number({ invalid_type_error: "Tarifa invalida" }).min(0, "La tarifa no puede ser negativa").max(100, "Tarifa invalida");
export const tarifasKmSchema = z.object({
  AUTO_FURGONCINO: tarifa.optional(),
  H1_L1: tarifa.optional(),
  H2_L2: tarifa.optional(),
  CASONATO: tarifa.optional(),
  DHL_AB: tarifa.optional(),
});
