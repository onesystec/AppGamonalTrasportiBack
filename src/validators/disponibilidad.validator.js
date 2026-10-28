import { z } from "zod";

const emptyToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const day = z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida (usa AAAA-MM-DD)").optional());

// Rango de dias a mostrar (sin indicarlo: hoy y los 13 dias siguientes). Maximo 62 dias.
export const disponibilidadQuerySchema = z.object({ desde: day, hasta: day });
