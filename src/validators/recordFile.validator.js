import { z } from "zod";

const TIPO_ARCHIVO_VALUES = ["CMR", "BOLLA", "FOTO_ENTREGA", "FACTURA", "COMPROBANTE", "OTRO"];

export const createRecordFileSchema = z.object({
  tipoArchivo: z.enum(TIPO_ARCHIVO_VALUES, {
    errorMap: () => ({ message: "Tipo de archivo invalido" }),
  }),
});

export const recordIdParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});

export const fileIdParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});
