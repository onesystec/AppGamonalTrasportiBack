import { z } from "zod";
import { MEMO_TIPO_KEYS } from "../constants/memorandums.js";

export const idParamSchema = z.object({ id: z.string().uuid("Id invalido") });

const destinatariosSchema = z.object({
  modo: z.enum(["CHOFERES", "RESPONSABLES", "AREA", "PERSONAS"], { errorMap: () => ({ message: "Elige a quien va el memorandum" }) }),
  areas: z.array(z.string()).max(10).optional(),
  userIds: z.array(z.string().uuid()).max(500).optional(),
});

export const emitMemorandumSchema = z.object({
  tipo: z.enum(MEMO_TIPO_KEYS, { errorMap: () => ({ message: "Tipo invalido" }) }),
  titulo: z.string().trim().min(3, "Escribe el asunto").max(160, "El asunto es demasiado largo"),
  cuerpo: z.string().trim().min(10, "Escribe el texto del memorandum").max(8000, "El texto es demasiado largo"),
  nivelFirma: z.enum(["ENTENDIDO", "FIRMA"]).optional(),
  // Dias para confirmar (se cuenta hasta las 23:59 de ese dia); sin valor, sin plazo.
  plazoDias: z.coerce.number().int().min(1).max(60).optional(),
  destinatarios: destinatariosSchema,
});

// Un memorandum de nivel ENTENDIDO se confirma con un toque (sin firma); uno de nivel FIRMA lleva la firma dibujada (PNG en base64).
export const signMemorandumSchema = z.object({
  firma: z.string().startsWith("data:image/png;base64,", "La firma debe ser una imagen PNG").max(200_000, "La firma es demasiado grande").optional(),
  acepto: z.literal(true, { errorMap: () => ({ message: "Debes confirmar que lo recibes" }) }),
});
