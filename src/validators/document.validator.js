import { z } from "zod";

const TIPO_DOCUMENTO_VALUES = [
  "CARTA_IDENTITA",
  "PASSAPORTO",
  "SOGGIORNO",
  "PATENTE",
  "TRADUZIONE_PATENTE",
  "CODICE_FISCALE",
  "CONTRATO",
  "UNILAV",
  "PERMESSO_TRASPORTO",
  "TREDICESIMA_QUATTORDICESIMA",
  "RESPONSIVAS",
];

export const createDocumentSchema = z.object({
  tipoDocumento: z.enum(TIPO_DOCUMENTO_VALUES, {
    errorMap: () => ({ message: "Tipo de documento invalido" }),
  }),
  fechaScadenza: z.coerce.date().optional(),
  // Solo lo usa la oficina (OWNER/ADMIN/RRHH) para cargar el documento de otro usuario; sin el, el documento es del propio usuario.
  usuarioId: z.string().uuid().optional(),
});

// Un update puede venir solo con un archivo nuevo y sin ningun campo de texto, por eso todo es opcional.
export const updateDocumentSchema = z.object({
  tipoDocumento: z.enum(TIPO_DOCUMENTO_VALUES).optional(),
  fechaScadenza: z.coerce.date().optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});

// Solo tiene efecto para OWNER/ADMIN; un CHOFER siempre ve unicamente los propios.
export const listDocumentsQuerySchema = z.object({
  usuarioId: z.string().uuid("usuarioId invalido").optional(),
});
