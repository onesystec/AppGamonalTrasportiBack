import { z } from "zod";

const emptyToUndefined = (value) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const clienteMesQuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mese non valido (usa AAAA-MM)").optional()),
});

export const clienteServicioIdSchema = z.object({ id: z.string().uuid("Id non valido") });

// Ancho de las columnas de las hojas tipo Excel: { hoja } en la ruta y { anchos: { A: 120, ... } } (px) en el cuerpo.
export const hojaAnchosParamsSchema = z.object({ hoja: z.enum(["dhl", "roma", "ab", "extra"], { errorMap: () => ({ message: "Foglio non valido" }) }) });
export const hojaAnchosBodySchema = z.object({
  anchos: z
    .record(z.string().regex(/^[A-Z]$/, "Colonna non valida"), z.coerce.number().int("Larghezza non valida").min(30, "Larghezza troppo piccola").max(800, "Larghezza troppo grande"))
    .refine((v) => Object.keys(v).length <= 10, { message: "Troppe colonne" }),
});

// Editar una celda (o las dos de SHIPMENT/ORDER) de la hoja tipo Excel: origen "solicitud" | "servicio", su id y { campo: valor } tal como se escribio.
const valorCelda = z.union([z.string().max(300, "Valore troppo lungo"), z.null()]);
export const editarCeldaSchema = z.object({
  origen: z.enum(["solicitud", "servicio"], { errorMap: () => ({ message: "Origine non valida" }) }),
  id: z.string().uuid("Id non valido"),
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
    .refine((v) => Object.keys(v).length > 0, { message: "Nessuna modifica" }),
});

export const cambiosQuerySchema = z.object({ recordId: z.preprocess(emptyToUndefined, z.string().uuid("Id invalido").optional()) });
export const cambiosLeerSchema = z.object({ ids: z.array(z.string().uuid("Id invalido")).max(200).optional() });
