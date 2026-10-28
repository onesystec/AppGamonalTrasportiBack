import { z } from "zod";

export const CONCEPTOS = ["ACEITE", "REFRIGERANTE", "LAVADO", "NEUMATICOS", "REPUESTO", "OTRO"];
const ESTADOS = ["PENDIENTE", "REEMBOLSADO", "RECHAZADO"];

// Los formularios llegan como multipart: todo viene como string y un campo opcional sin completar puede venir vacio.
const emptyToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const base = {
  concepto: z.enum(CONCEPTOS, { errorMap: () => ({ message: "Elige que compraste" }) }),
  descripcion: z.preprocess(emptyToUndefined, z.string().trim().max(300).optional()),
  // "12,50" tambien vale (teclado del celular).
  monto: z.preprocess(
    (v) => (typeof v === "string" ? v.replace(",", ".") : v),
    z.coerce.number({ errorMap: () => ({ message: "Pon el importe" }) }).positive("El importe debe ser mayor a 0").max(100000, "Importe demasiado alto")
  ),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida"),
  targa: z.preprocess(emptyToUndefined, z.string().trim().max(20).optional()),
};

// "Otro" necesita decir que fue.
const rules = (data, ctx) => {
  if (data.concepto === "OTRO" && !data.descripcion) {
    ctx.addIssue({ code: "custom", path: ["descripcion"], message: "Cuenta brevemente que compraste" });
  }
};

export const createOtroGastoSchema = z.object(base).superRefine(rules);
export const updateOtroGastoSchema = z
  .object({ ...base, quitarComprobante: z.preprocess((v) => v === "true" || v === true, z.boolean()) })
  .superRefine(rules);

export const listOtrosGastosQuerySchema = z.object({
  estado: z.preprocess(emptyToUndefined, z.enum(ESTADOS).optional()),
  driverId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()),
});

export const reviewOtroGastoSchema = z
  .object({
    accion: z.enum(["REEMBOLSAR", "RECHAZAR"]),
    nota: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
  })
  .superRefine((data, ctx) => {
    if (data.accion === "RECHAZAR" && !data.nota) ctx.addIssue({ code: "custom", path: ["nota"], message: "Explica el motivo" });
  });
