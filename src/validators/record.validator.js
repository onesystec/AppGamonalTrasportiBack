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
  // Declaraciones del chofer: no uso peaje de ida / de vuelta, no hizo falta combustible.
  sinPeajeIda: z.boolean().optional(),
  sinPeajeVuelta: z.boolean().optional(),
  sinCombustible: z.boolean().optional(),
};

// Paradas del servicio, en orden. El deposito de partida es fijo (no se envia desde el
// cliente) y "destinazione" se deriva en el backend a partir de la ultima parada.
// Cada parada es un texto (se geocodifica) o { direccion, lat, lng } cuando viene de una sugerencia con ubicacion
// exacta (no se geocodifica). Siempre sale como objeto { direccion, lat?, lng? }.
const stopObject = z
  .object({
    direccion: z.string().trim().min(1, "La direccion de la parada no puede estar vacia").max(200),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat == null) === (v.lng == null), { message: "lat y lng van juntas" });
const stopField = z.preprocess((v) => (typeof v === "string" ? { direccion: v } : v), stopObject);
const stopsField = z
  .array(stopField)
  .min(1, "Debe haber al menos una parada")
  .max(10, "Maximo 10 paradas");

// Punto de salida del servicio (opcional): una direccion de texto y, si viene de una sugerencia con
// ubicacion exacta, sus coordenadas (sin ellas se geocodifica el texto). null = volver al deposito.
const salidaField = z
  .object({
    direccion: z.string().trim().min(1, "La direccion de salida no puede estar vacia").max(200),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat == null) === (v.lng == null), { message: "lat y lng van juntas" });

// Los formularios mandan las fechas como hora "de pared" sin zona (AAAA-MM-DDTHH:mm): se
// interpretan como hora de Roma (la operacion es ahi), sin depender de la zona del navegador ni del
// servidor. Lo que escribe la oficina es exactamente lo que se guarda y se muestra. Un ISO completo
// (con zona) pasa tal cual.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const romeWallClock = (value) =>
  typeof value === "string" && WALL_CLOCK.test(value) ? romeLocalToDate(value.slice(0, 10), value.slice(11, 16)) : value;

// Cuando sale realmente el vehiculo. "" (o null) la borra al editar.
const fechaRetiro = z.preprocess(
  (value) => (value === "" || value === null ? null : romeWallClock(value)),
  z.coerce.date({ errorMap: () => ({ message: "fechaRetiro invalida" }) }).nullable().optional()
);

export const createRecordSchema = z.object({
  driverId: z.string().uuid("driverId invalido"),
  vehicleId: z.string().uuid("vehicleId invalido"),
  clientId: z.string().uuid("clientId invalido"),
  // Ya no se carga: el dia del servicio es el de la salida (Fecha retiro) o, si no hay, el de la ETA. Se acepta (y se
  // usa si no hay hora de salida) por los servicios que entran por Telegram.
  fechaServicio: z.preprocess(romeWallClock, z.coerce.date({ errorMap: () => ({ message: "fechaServicio invalida" }) }).optional()),
  eta: z.preprocess(romeWallClock, z.coerce.date({ errorMap: () => ({ message: "eta invalida" }) })),
  fechaRetiro,
  retiroPaqueteAt: fechaRetiro,
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
  salida: salidaField.optional(),
  ...operationalFields,
  ...economicFields,
});

export const updateRecordSchema = z.object({
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  fechaServicio: z.preprocess(romeWallClock, z.coerce.date().optional()),
  eta: z.preprocess(romeWallClock, z.coerce.date().optional()),
  fechaRetiro,
  retiroPaqueteAt: fechaRetiro,
  descripcion: z.string().trim().min(1).optional(),
  codigo: z.string().trim().min(1).optional(),
  ciudad: z.string().trim().optional(),
  aplicativo: z.enum(APLICATIVO_VALUES).optional(),
  spedizzione: z.enum(SPEDIZZIONE_VALUES).optional(),
  extrasPiazzaZona: z.enum(EXTRAS_PIAZZA_ZONA_VALUES).optional(),
  stops: stopsField.optional(),
  salida: salidaField.nullable().optional(),
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

// Switches de peajes y carburante del servicio (chofer u oficina).
export const declaracionesSchema = z
  .object({
    sinPeajeIda: z.boolean().optional(),
    sinPeajeVuelta: z.boolean().optional(),
    sinCombustible: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Indica al menos una declaracion" });

// Excepcion de la oficina: al aplicarla el motivo es obligatorio.
export const excepcionSchema = z
  .object({
    aplicar: z.boolean(),
    nota: z.string().trim().max(300).optional(),
  })
  .refine((data) => !data.aplicar || (data.nota && data.nota.length >= 3), {
    message: "Explica el motivo de la excepcion",
    path: ["nota"],
  });

// Servicios (en el orden de las paradas) de un viaje compacto: el primero es el principal.
export const compactarSchema = z.object({
  recordIds: z.array(z.string().uuid("Servicio invalido")).min(1).max(8),
});

// Reparto de km reales de un viaje compacto, hecho por la oficina: todos los servicios del viaje con sus km.
export const kmViajeSchema = z.object({
  reparto: z
    .array(z.object({ id: z.string().uuid("Servicio invalido"), km: z.coerce.number().min(0, "Los km no pueden ser negativos").max(5000) }))
    .min(2)
    .max(8),
  nota: z.string().trim().max(500).optional(),
});

export const compactadoIdParamSchema = z.object({ compactadoId: z.string().uuid("Viaje invalido") });
