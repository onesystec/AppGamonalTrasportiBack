import { z } from "zod";

const AREA_VALUES = ["EXTRAS_PIAZZA", "DHL", "FARMACIA"];
const GRUPO_VALUES = ["SOCIEDAD", "MILANO_NORD", "MILANO_SUD", "ROMA", "FARMACIA"];
const CARGO_VALUES = ["OWNER", "ADMIN", "CHOFER"];
const ESTADO_VALUES = ["ACTIVO", "INACTIVO"];

const passwordSchema = z
  .string()
  .min(8, "La contrasena debe tener al menos 8 caracteres");

export const createUserSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  apellido: z.string().trim().min(1, "El apellido es obligatorio"),
  area: z.enum(AREA_VALUES, { errorMap: () => ({ message: "Area invalida" }) }),
  grupo: z.enum(GRUPO_VALUES, { errorMap: () => ({ message: "Grupo invalido" }) }).optional(),
  cargo: z.enum(CARGO_VALUES, { errorMap: () => ({ message: "Cargo invalido" }) }),
  estado: z.enum(ESTADO_VALUES).optional(),
  fechaNacimiento: z.coerce.date({ errorMap: () => ({ message: "Fecha de nacimiento invalida" }) }),
  numeroCelular: z.string().trim().min(6, "Numero de celular invalido"),
  correoElectronico: z.string().trim().email("Correo electronico invalido"),
  password: passwordSchema,
});

export const updateUserSchema = z
  .object({
    nombre: z.string().trim().min(1).optional(),
    apellido: z.string().trim().min(1).optional(),
    area: z.enum(AREA_VALUES).optional(),
    grupo: z.enum(GRUPO_VALUES).optional(),
    cargo: z.enum(CARGO_VALUES).optional(),
    estado: z.enum(ESTADO_VALUES).optional(),
    fechaNacimiento: z.coerce.date().optional(),
    numeroCelular: z.string().trim().min(6).optional(),
    correoElectronico: z.string().trim().email().optional(),
    password: passwordSchema.optional(),
    compartirUbicacion: z.boolean().optional(),
    vehiculoAsignadoId: z.string().uuid("Vehiculo invalido").nullable().optional(),
    reperibilidadNoDisponible: z.boolean().optional(),
    proximoServicioFecha: z.coerce.date().nullable().optional(),
    proximoServicioNota: z.string().trim().max(500).nullable().optional(),
    direccion: z.string().trim().max(200).nullable().optional(),
    contactoEmergenciaNombre: z.string().trim().max(100).nullable().optional(),
    contactoEmergenciaParentesco: z.string().trim().max(50).nullable().optional(),
    contactoEmergenciaTelefono: z.string().trim().max(30).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debe enviar al menos un campo para actualizar",
  });

export const idParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
});

export const updateLocationSchema = z.object({
  lat: z.coerce.number().min(-90, "Latitud invalida").max(90, "Latitud invalida"),
  lng: z.coerce.number().min(-180, "Longitud invalida").max(180, "Longitud invalida"),
  // Radio de incertidumbre en metros que reporta el propio GPS del celular (puede no
  // venir, ej. si el navegador no lo expone) - se usa para descartar fixes de mala
  // calidad antes de que contaminen la ubicacion en vivo o el historial de ruta.
  accuracy: z.coerce.number().min(0).optional(),
});

export const updateLocationPermissionSchema = z.object({
  denegado: z.boolean(),
});

export const updateReperibilidadSchema = z.object({
  noDisponible: z.boolean(),
});

// Token de dispositivo (Firebase Cloud Messaging, ver pushNotification.service.js) -
// platform solo informativo por ahora (siempre "android", la app todavia no se
// distribuye para iOS).
export const registerPushTokenSchema = z.object({
  token: z.string().min(1, "El token es obligatorio"),
  platform: z.enum(["android", "ios"]).default("android"),
});

export const unregisterPushTokenSchema = z.object({
  token: z.string().min(1, "El token es obligatorio"),
});

export const routeHistoryParamSchema = z.object({
  id: z.string().uuid("Id invalido"),
  year: z.coerce.number().int().min(1970).max(3000),
  month: z.coerce.number().int().min(1).max(12),
  day: z.coerce.number().int().min(1).max(31),
});
