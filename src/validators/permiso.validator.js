import { z } from "zod";

const TIPOS = ["PERMISO", "ENFERMEDAD", "VACACIONES", "OTRO", "DESCANSO"];

const dateOnly = (label) =>
  z
    .string({ required_error: `${label} es obligatoria` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} invalida`)
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${label} invalida`);

export const createPermisoSchema = z.object({
  // Solo lo usa la oficina para cargar un permiso/descanso en nombre de un chofer.
  driverId: z.string().uuid("Elige el chofer").optional(),
  tipo: z.enum(TIPOS, { errorMap: () => ({ message: "Tipo invalido" }) }).default("PERMISO"),
  fechaDesde: dateOnly("La fecha"),
  fechaHasta: dateOnly("La fecha final").optional(),
  motivo: z.string().trim().max(500, "El motivo es demasiado largo").default(""),
});

export const listPermisosQuerySchema = z.object({
  estado: z.enum(["PENDIENTE", "APROBADO", "RECHAZADO", "TODAS"]).default("TODAS"),
  driverId: z.string().uuid().optional(),
});

export const calendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido"),
  driverId: z.string().uuid().optional(),
});

export const reviewPermisoSchema = z
  .object({
    accion: z.enum(["APROBAR", "RECHAZAR"], { errorMap: () => ({ message: "Accion invalida" }) }),
    respuesta: z.string().trim().max(500).optional(),
    // Aprobar aunque se supere el tope de permisos por dia (decision de la oficina).
    forzar: z.boolean().optional(),
  })
  .refine((v) => v.accion !== "RECHAZAR" || (v.respuesta && v.respuesta.length > 0), {
    message: "Escribe el motivo del rechazo para que el chofer lo vea",
    path: ["respuesta"],
  });

// maxPorDia null = sin tope.
export const permisosConfigSchema = z.object({
  maxPorDia: z.coerce.number().int("Debe ser un numero entero").min(1, "Minimo 1").max(100).nullable(),
});

export const overviewQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido"),
});
