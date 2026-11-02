import { z } from "zod";

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const clienteMesQuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes invalido (usa AAAA-MM)").optional()),
});

export const clienteServicioIdSchema = z.object({ id: z.string().uuid("Id invalido") });

// Ancho de las columnas de las hojas tipo Excel: { hoja } en la ruta y { anchos: { A: 120, ... } } (px) en el cuerpo.
export const hojaAnchosParamsSchema = z.object({ hoja: z.enum(["dhl", "roma", "ab", "extra"], { errorMap: () => ({ message: "Hoja invalida" }) }) });
export const hojaAnchosBodySchema = z.object({
  anchos: z
    .record(z.string().regex(/^[A-Z]$/, "Columna invalida"), z.coerce.number().int("Ancho invalido").min(30, "Ancho demasiado chico").max(800, "Ancho demasiado grande"))
    .refine((v) => Object.keys(v).length <= 10, { message: "Demasiadas columnas" }),
});

// Editar una celda (o las dos de SHIPMENT/ORDER) de la hoja tipo Excel: origen "solicitud" | "servicio", su id y { campo: valor } tal como se escribio.
const valorCelda = z.union([z.string().max(300, "Valore troppo lungo"), z.null()]);
export const editarCeldaSchema = z.object({
  origen: z.enum(["solicitud", "servicio"], { errorMap: () => ({ message: "Origen invalido" }) }),
  id: z.string().uuid("Id invalido"),
  cambios: z
    .object({
      shipment: valorCelda,
      orderNumero: valorCelda,
      tipoPedido: valorCelda,
      cliente: valorCelda,
      ciudad: valorCelda,
      eta: valorCelda,
      km: valorCelda,
      aplicativo: valorCelda,
      ritiro: valorCelda,
    })
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: "No hay cambios" }),
});

export const cambiosQuerySchema = z.object({ recordId: z.preprocess(emptyToUndefined, z.string().uuid("Id invalido").optional()) });
export const cambiosLeerSchema = z.object({ ids: z.array(z.string().uuid("Id invalido")).max(200).optional() });
