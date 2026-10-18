import { z } from "zod";
import { romeLocalToDate } from "../utils/romeTime.js";

const AREA_TIPOS = ["DHL", "EXTRAS", "FARMACIA", "OTROS"];
const ESTADOS = ["PENDIENTE", "APROBADO", "DEVUELTO"];

// Los formularios llegan como multipart: todo viene como string y un campo opcional sin completar puede venir vacio.
const emptyToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const boolString = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
// El formulario manda la hora "de pared" sin zona (AAAA-MM-DDTHH:mm) y se interpreta como hora de Roma (igual que las jornadas).
const dateTime = z.preprocess(
  (value) =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? romeLocalToDate(value.slice(0, 10), value.slice(11, 16)) : value,
  z.coerce.date({ errorMap: () => ({ message: "Fecha u hora invalida" }) })
);

const base = {
  areaTipo: z.enum(AREA_TIPOS, { errorMap: () => ({ message: "Elige el area" }) }),
  zona: z.preprocess(emptyToUndefined, z.enum(["MILANO", "ROMA"]).optional()),
  areaOtros: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
  inicio: dateTime,
  fin: dateTime,
  pausaMin: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(600).optional()),
  descripcion: z.string().trim().min(3, "Cuenta brevemente que hiciste").max(500),
  solicitadoPor: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
  sinVehiculo: z.preprocess(emptyToUndefined, boolString.optional()),
  targa: z.preprocess(emptyToUndefined, z.string().trim().max(20).optional()),
  km: z.preprocess(emptyToUndefined, z.coerce.number().min(0, "Los km no pueden ser negativos").max(5000).optional()),
};

// Reglas que cruzan campos (zona en DHL y Extras, "otros" especificado, targa si hay vehiculo).
const rules = (data, ctx) => {
  if ((data.areaTipo === "DHL" || data.areaTipo === "EXTRAS") && !data.zona) {
    ctx.addIssue({ code: "custom", path: ["zona"], message: "Elige Milano o Roma" });
  }
  if (data.areaTipo === "OTROS" && !data.areaOtros) {
    ctx.addIssue({ code: "custom", path: ["areaOtros"], message: "Especifica el area" });
  }
  if (!data.sinVehiculo && !data.targa) {
    ctx.addIssue({ code: "custom", path: ["targa"], message: "Elige la targa o marca que no usaste vehiculo" });
  }
};

export const createTrabajoAdicionalSchema = z.object(base).superRefine(rules);
// Al corregir: las fotos ya guardadas que el chofer quita (llegan repetidas en el multipart: una sola viene como texto).
const quitarFotos = z.preprocess((v) => (v == null || v === "" ? [] : Array.isArray(v) ? v : [v]), z.array(z.string().max(300)).max(10));
export const updateTrabajoAdicionalSchema = z.object({ ...base, quitarFotos }).superRefine(rules);

export const listTrabajosAdicionalesQuerySchema = z.object({
  estado: z.preprocess(emptyToUndefined, z.enum(ESTADOS).optional()),
  driverId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}$/).optional()),
});

export const reviewTrabajoAdicionalSchema = z
  .object({
    accion: z.enum(["APROBAR", "DEVOLVER"]),
    nota: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
    inicio: z.preprocess(emptyToUndefined, dateTime.optional()),
    fin: z.preprocess(emptyToUndefined, dateTime.optional()),
  })
  .superRefine((data, ctx) => {
    if (data.accion === "DEVOLVER" && !data.nota) ctx.addIssue({ code: "custom", path: ["nota"], message: "Explica que debe corregir" });
    if ((data.inicio || data.fin) && !data.nota) ctx.addIssue({ code: "custom", path: ["nota"], message: "Si ajustas los tiempos, anota el motivo" });
  });
