import { z } from "zod";
import { SOLICITUD_SERVICIO_KEYS } from "../constants/solicitudes.js";
import { romeLocalToDate } from "../utils/romeTime.js";

const APLICATIVO_VALUES = [
  ...Array.from({ length: 18 }, (_, i) => `MILANO_${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ROMA_${i + 1}`),
];

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const emptyToNull = (value) => (value === undefined || (typeof value === "string" && value.trim() === "") ? null : value);

// El formulario manda la hora "de pared" sin zona (AAAA-MM-DDTHH:mm): se interpreta como hora de Roma, igual que en los servicios.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const romeWallClock = (value) =>
  typeof value === "string" && WALL_CLOCK.test(value) ? romeLocalToDate(value.slice(0, 10), value.slice(11, 16)) : value;

const text = (label, max) =>
  z.string({ required_error: `${label} es obligatorio` }).trim().min(1, `${label} es obligatorio`).max(max, `${label} es demasiado largo`);
const optionalText = (max) => z.preprocess(emptyToNull, z.string().trim().max(max, "Texto demasiado largo").nullable());
const optionalNumber = (label) =>
  z.preprocess(emptyToNull, z.coerce.number({ invalid_type_error: `${label} invalido` }).min(0, `${label} invalido`).max(1e6, `${label} invalido`).nullable());

const fields = {
  servicio: z.enum(SOLICITUD_SERVICIO_KEYS, { errorMap: () => ({ message: "Elige el tipo de servicio" }) }),
  cliente: text("El cliente", 150),
  destinazione: text("La destinazione", 250),
  fechaHora: z.preprocess(romeWallClock, z.coerce.date({ errorMap: () => ({ message: "La fecha y hora son invalidas" }) })),
  km: optionalNumber("Los km"),
  pagato: optionalNumber("El importe pagado"),
  varie: optionalText(4000),
  varie2: optionalText(2000),
  aplicativo: z.preprocess(emptyToNull, z.enum(APLICATIVO_VALUES, { errorMap: () => ({ message: "Numero invalido" }) }).nullable()),
};

export const createSolicitudSchema = z.object(fields);
export const updateSolicitudSchema = z.object(fields).partial().refine((v) => Object.keys(v).length > 0, { message: "No hay cambios" });

export const solicitudIdSchema = z.object({ id: z.string().uuid("Id invalido") });

export const listSolicitudesQuerySchema = z.object({
  estado: z.preprocess(emptyToUndefined, z.enum(["PENDIENTE", "ACEPTADA", "RECHAZADA", "TODAS"]).default("PENDIENTE")),
});

export const rechazarSolicitudSchema = z.object({
  motivo: z.preprocess(emptyToNull, z.string().trim().max(500, "El motivo es demasiado largo").nullable()),
});
