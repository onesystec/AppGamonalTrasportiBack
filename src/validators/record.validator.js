import { z } from "zod";
import { romeLocalToDate } from "../utils/romeTime.js";

const RECORD_STATUS_VALUES = [
  "CONSEGNATO",
  "IN_CONSEGNA",
  "IN_SOSPESO",
  "RITIRATO",
  "ANNULLATO",
  "RISCHEDULATO",
];

// ROMA_1..10 se agrego junto a los MILANO_1..18 ya existentes (ver APLICATIVO_OPTIONS
// en constants.js del front, mismo criterio: no renombrar el historico). Roma tiene
// menos aplicativos que Milano (10, no 18) - circuitos reales de esa operacion.
const APLICATIVO_VALUES = [
  ...Array.from({ length: 18 }, (_, i) => `MILANO_${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ROMA_${i + 1}`),
];
const SPEDIZZIONE_VALUES = ["DHL", "AB_SERVICE", "EXTRA_PIAZZA", "EXTRAS_STEFANIA"];
const EXTRAS_PIAZZA_ZONA_VALUES = ["MILANO", "ROMA"];

const economicFields = {
  kilometros: z.coerce.number().optional(),
  precioKm: z.coerce.number().optional(),
  areaC: z.coerce.number().optional(),
  costoEspera: z.coerce.number().optional(),
  costoTraforoFrejusBrennero: z.coerce.number().optional(),
  peajes: z.coerce.number().optional(),
  vignetta: z.coerce.number().optional(),
  costoHotel: z.coerce.number().optional(),
  costoOtros: z.coerce.number().optional(),
  pagoRecibido: z.coerce.number().optional(),
  costoCombustible: z.coerce.number().optional(),
  clienteConfirmado: z.coerce.boolean().optional(),
};

// Campos operativos: los unicos que un CHOFER puede tocar en su propio record
// (el filtrado real por rol pasa en record.service.js, esto solo valida tipos).
const operationalFields = {
  estado: z.enum(RECORD_STATUS_VALUES, { errorMap: () => ({ message: "Estado invalido" }) }).optional(),
  horasDia: z.coerce.number().optional(),
  horasNoche: z.coerce.number().optional(),
  tiempoEspera: z.coerce.number().optional(),
  comentarios: z.string().trim().optional(),
  kilometrosReales: z.coerce.number().optional(),
};

// Paradas del servicio, en orden. El deposito de partida es fijo (no se envia desde el
// cliente) y "destinazione" se deriva en el backend a partir de la ultima parada.
const stopsField = z
  .array(z.string().trim().min(1, "La direccion de la parada no puede estar vacia"))
  .min(1, "Debe haber al menos una parada")
  .max(10, "Maximo 10 paradas");

// Cuando sale realmente el vehiculo. "" (o null) la borra al editar.
// El formulario manda la hora "de pared" sin zona (AAAA-MM-DDTHH:mm): se interpreta como hora de
// Roma (la operacion es ahi), sin depender de la zona del navegador ni del servidor.
const fechaRetiro = z.preprocess(
  (value) => {
    if (value === "" || value === null) return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      return romeLocalToDate(value.slice(0, 10), value.slice(11, 16));
    }
    return value;
  },
  z.coerce.date({ errorMap: () => ({ message: "fechaRetiro invalida" }) }).nullable().optional()
);

export const createRecordSchema = z.object({
  driverId: z.string().uuid("driverId invalido"),
  vehicleId: z.string().uuid("vehicleId invalido"),
  clientId: z.string().uuid("clientId invalido"),
  fechaServicio: z.coerce.date({ errorMap: () => ({ message: "fechaServicio invalida" }) }),
  eta: z.coerce.date({ errorMap: () => ({ message: "eta invalida" }) }),
  fechaRetiro,
  descripcion: z.string().trim().min(1, "La descripcion es obligatoria"),
  codigo: z.string().trim().min(1, "El codigo es obligatorio"),
  ciudad: z.string().trim().optional(),
  aplicativo: z.enum(APLICATIVO_VALUES, { errorMap: () => ({ message: "Aplicativo invalido" }) }).optional(),
  spedizzione: z.enum(SPEDIZZIONE_VALUES, { errorMap: () => ({ message: "Spedizzione invalida" }) }).optional(),
  extrasPiazzaZona: z
    .enum(EXTRAS_PIAZZA_ZONA_VALUES, { errorMap: () => ({ message: "Zona invalida" }) })
    .optional(),
  origenExternoId: z.string().trim().min(1).optional(),
  stops: stopsField,
  ...operationalFields,
  ...economicFields,
});

export const updateRecordSchema = z.object({
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  fechaServicio: z.coerce.date().optional(),
  eta: z.coerce.date().optional(),
  fechaRetiro,
  descripcion: z.string().trim().min(1).optional(),
  codigo: z.string().trim().min(1).optional(),
  ciudad: z.string().trim().optional(),
  aplicativo: z.enum(APLICATIVO_VALUES).optional(),
  spedizzione: z.enum(SPEDIZZIONE_VALUES).optional(),
  extrasPiazzaZona: z.enum(EXTRAS_PIAZZA_ZONA_VALUES).optional(),
  stops: stopsField.optional(),
  // Chofer que termino el servicio en lugar del asignado (null = nadie, quita el relevo).
  choferRelevoId: z.string().uuid("choferRelevoId invalido").nullable().optional(),
  ...operationalFields,
  ...economicFields,
});

// Listas separadas por coma en query string (?secciones=DHL,AB_SERVICE) - tambien
// acepta el mismo param repetido (Express ya lo arma como array en ese caso).
const csvEnumList = (values) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v == null) return undefined;
      const arr = Array.isArray(v) ? v : v.split(",");
      return arr.map((s) => s.trim()).filter(Boolean);
    })
    .refine((arr) => !arr || arr.every((s) => values.includes(s)), { message: "Valor invalido en la lista" });

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

// "" no es lo mismo que ausente para .optional() (solo acepta undefined) - un campo
// opcional vacio en un <input> del front (ej. un <input type="time"> tocado y despues
// borrado) manda "" en vez de omitir el parametro, y sin esto eso tira 400 igual que si
// el usuario hubiera cargado un dato invalido (mismo bug ya visto con "grupo" en
// user.validator.js). Se trata "" como si no se hubiera mandado nada.
const emptyToUndefined = (schema) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

// GET /records/export (ver ExportRecordsModal.jsx del front) - todos los filtros son
// opcionales, sin ninguno exporta el historico completo.
export const exportRecordsQuerySchema = z.object({
  from: emptyToUndefined(z.coerce.date()),
  to: emptyToUndefined(z.coerce.date()),
  fromTime: emptyToUndefined(z.string().regex(HHMM_REGEX, "Hora invalida (HH:mm)")),
  toTime: emptyToUndefined(z.string().regex(HHMM_REGEX, "Hora invalida (HH:mm)")),
  driverId: emptyToUndefined(z.string().uuid("driverId invalido")),
  clientId: emptyToUndefined(z.string().uuid("clientId invalido")),
  vehicleId: emptyToUndefined(z.string().uuid("vehicleId invalido")),
  secciones: csvEnumList(SPEDIZZIONE_VALUES),
  zonas: csvEnumList(EXTRAS_PIAZZA_ZONA_VALUES),
  estados: csvEnumList(RECORD_STATUS_VALUES),
});

export const idParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});

export const yearParamSchema = z.object({
  year: z.coerce.number().int().min(1970).max(3000),
});

export const yearMonthParamSchema = yearParamSchema.extend({
  month: z.coerce.number().int().min(1).max(12),
});

export const yearMonthDayParamSchema = yearMonthParamSchema.extend({
  day: z.coerce.number().int().min(1).max(31),
});
