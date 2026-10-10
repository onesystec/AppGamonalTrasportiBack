import { z } from "zod";
import { romeLocalToDate } from "../utils/romeTime.js";

// Mismo criterio que fechaRetiro en record.validator.js: el formulario manda la hora "de pared"
// sin zona (AAAA-MM-DDTHH:mm) y se interpreta como hora de Roma.
const romeDateTime = (label) =>
  z.preprocess(
    (value) => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
        return romeLocalToDate(value.slice(0, 10), value.slice(11, 16));
      }
      return value;
    },
    z.coerce.date({ errorMap: () => ({ message: `${label} invalida` }) })
  );

const minutes = (label) =>
  z.coerce
    .number({ invalid_type_error: `${label} invalida` })
    .int(`${label} debe ser un numero entero de minutos`)
    .min(0, `${label} no puede ser negativa`)
    .max(24 * 60, `${label} invalida`);

const jornadaFields = {
  inicio: romeDateTime("La hora de inicio"),
  fin: romeDateTime("La hora de fin"),
  esperaMin: minutes("La espera").default(0),
  pausaMin: minutes("La pausa").default(0),
};

export const submitHorasSchema = z.object({
  ...jornadaFields,
  kilometrosReales: z.coerce.number().min(0).optional(),
  // Viaje compacto con km de mas: en que servicios fueron (si es en varios se reparten) y por que.
  kmExtra: z
    .object({
      servicioIds: z.array(z.string().uuid("Servicio invalido")).max(8).default([]),
      nota: z.string().trim().max(500).optional(),
    })
    .optional(),
  comentarios: z.string().trim().max(1000).optional(),
  // "Terminar servicio": ademas de las horas, marca el servicio como entregado en la misma
  // operacion (si ya lo estaba no cambia nada).
  entregado: z.boolean().optional(),
  // Termino sin pasar por el lugar de espera (por ejemplo fue directo a casa): "fin" es la hora de llegada.
  finFueraDeBase: z.boolean().optional(),
});

// "ajuste": la oficina corrige la jornada al aprobarla; todos opcionales, sin ellos se aprueba
// lo que mando el chofer.
export const reviewHorasSchema = z
  .object({
    accion: z.enum(["APROBAR", "DEVOLVER"], { errorMap: () => ({ message: "Accion invalida" }) }),
    nota: z.string().trim().max(500).optional(),
    inicio: jornadaFields.inicio.optional(),
    fin: jornadaFields.fin.optional(),
    esperaMin: minutes("La espera").optional(),
    pausaMin: minutes("La pausa").optional(),
  })
  .refine((v) => v.accion !== "DEVOLVER" || (v.nota && v.nota.length > 0), {
    message: "Escribe el motivo para devolver las horas al chofer",
    path: ["nota"],
  });

export const pendientesQuerySchema = z.object({
  estado: z.enum(["PENDIENTE", "DEVUELTAS", "TODAS"]).default("PENDIENTE"),
});

export const receptionSchema = z.object({
  hora: romeDateTime("La hora"),
});
