import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("*"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatorio"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  RESET_TOKEN_EXPIRES_MINUTES: z.coerce.number().default(30),
  RESET_PASSWORD_URL: z.string().url(),

  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY es obligatorio"),
  RESEND_FROM_EMAIL: z.string().min(1, "RESEND_FROM_EMAIL es obligatorio"),

  R2_ACCOUNT_ID: z.string().min(1, "R2_ACCOUNT_ID es obligatorio"),
  R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID es obligatorio"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY es obligatorio"),
  R2_BUCKET_NAME: z.string().min(1, "R2_BUCKET_NAME es obligatorio"),
  R2_SIGNED_URL_EXPIRES_SECONDS: z.coerce.number().default(900),

  // Reemplaza a Nominatim (bloqueaba/limitaba por IP compartida en Render). Se pide
  // en Google Cloud Console > APIs & Services, habilitando "Geocoding API".
  GOOGLE_MAPS_API_KEY: z.string().min(1, "GOOGLE_MAPS_API_KEY es obligatorio"),
  OSRM_BASE_URL: z.string().url().default("https://router.project-osrm.org"),

  // GPS de vehiculo (seccion Mapa) - Refresh Token de la cuenta de Velocity Fleet, ver
  // https://api-docs.velocityfleet.com/authentication. Opcional a proposito: sin esto
  // el Mapa sigue andando igual, solo que con la ubicacion del celular del chofer en
  // vez de la del GPS del vehiculo (ver velocityFleet.service.js).
  VELOCITY_FLEET_REFRESH_TOKEN: z.string().optional(),

  // GPS del celular del chofer (ubicacion en vivo + historial LocationPing). Apagado por
  // defecto: la ubicacion sale del GPS del vehiculo (Velocity Fleet). Con "false" el
  // backend ignora (sin error) lo que mande una app vieja, no guarda nada y no lista
  // ubicaciones de celulares; poner "true" para volver a usarlo.
  PHONE_LOCATION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Dias de historial de LocationPing (recorrido GPS del celular del chofer, ver
  // "Ruta chofer"/"Recorrido real (GPS)") que se conservan antes de poder borrarlos con
  // /api/users/location-pings/cleanup - medida de optimizacion de costos (storage de
  // Neon), ver ese endpoint en user.controller.js.
  LOCATION_PING_RETENTION_DAYS: z.coerce.number().default(90),

  // Fotos de comprobante de los servicios (RecordFile en R2): pasados estos dias desde que
  // se subieron se borran solas (archivo en R2 + fila) para no acumular storage - ver
  // cleanupExpiredRecordFiles en recordFile.service.js. 0 desactiva el borrado. Solo
  // aplica a los tipos de RECORD_FILE_RETENTION_TYPES (coma-separados): CMR y FACTURA
  // quedan fuera a proposito (son documentos de transporte/fiscales, no fotos). NUNCA toca
  // los documentos de choferes ni de vehiculos (tabla Documento), solo RecordFile.
  RECORD_FILE_RETENTION_DAYS: z.coerce.number().default(90),
  RECORD_FILE_RETENTION_TYPES: z
    .string()
    .default("FOTO_ENTREGA,COMPROBANTE")
    .transform((value) =>
      value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    )
    .refine(
      (types) => types.every((t) => ["CMR", "FOTO_ENTREGA", "FACTURA", "COMPROBANTE", "OTRO"].includes(t)),
      "RECORD_FILE_RETENTION_TYPES tiene un tipo invalido"
    ),

  // Dias que se conserva un AreaCEntry SIN PAGAR (alerta de vehiculo sin autorizacion
  // dentro del Area C, ver vehicle.service.js) antes de poder borrarlo con
  // /api/vehiculos/area-c-entries/cleanup. Default chico (3 dias) a proposito: en
  // Milano se paga el Area C el mismo dia o el siguiente, pasado eso el dato ya no
  // sirve para nada. Una vez marcada pagada, la entrada NUNCA se borra sola (queda
  // como comprobante, igual que cualquier otro documento de la app).
  AREA_C_ENTRY_RETENTION_DAYS: z.coerce.number().default(3),

  // Exceso de velocidad (GPS del vehiculo, campanita de notificaciones) - umbral en
  // km/h (ver vehicle.service.js) y minutos para agrupar un exceso sostenido como el
  // mismo episodio en vez de una fila nueva cada 30-60s.
  SPEEDING_THRESHOLD_KMH: z.coerce.number().default(120),
  SPEEDING_DEDUP_MINUTES: z.coerce.number().default(20),
  // Dias que se conserva un SpeedingEvent antes de poder borrarlo con
  // /api/vehiculos/speeding-events/cleanup - a diferencia de AreaCEntry, esto no tiene
  // "pagado": es un aviso de manejo que se descarta con la X normal de la campanita,
  // asi que se poda entero pasado este plazo, sin excepciones.
  SPEEDING_EVENT_RETENTION_DAYS: z.coerce.number().default(30),

  // Paradas del vehiculo durante la jornada de un chofer: se calculan con el historial de GPS de la
  // plataforma OneSystec (su API, ver onesystec.service.js) cuando el chofer envia sus horas o la
  // oficina abre la aprobacion. Hoy es solo informativo, no cambia el pago. Sin estas dos variables
  // la funcion queda apagada (el resto de la app anda igual). La clave va SOLO aca, nunca en el codigo.
  ONESYSTEC_BASE_URL: z.string().url().optional(),
  ONESYSTEC_API_KEY: z.string().min(10).optional(),
  // Una parada se registra recien cuando el vehiculo lleva este tiempo detenido (minutos).
  STOP_MIN_MINUTES: z.coerce.number().default(5),
  // Hasta cuantos minutos una parada se considera normal (semaforo, baño, cafe) y no se revisa.
  STOP_TOLERANCE_MINUTES: z.coerce.number().default(15),
  // Metros que puede moverse el vehiculo y seguir "en la misma parada" (maniobras en un patio).
  STOP_RADIUS_METERS: z.coerce.number().default(120),
  // Metros a una parada del servicio o a un lugar de trabajo para considerar la parada como trabajo.
  STOP_SERVICE_RADIUS_METERS: z.coerce.number().default(250),
  // Lugares de trabajo ademas del deposito (aparcamiento de la empresa, etc.): una parada ahi no es
  // una parada "a revisar". JSON: [{"nombre":"Aparcamiento","lat":45.42,"lng":9.29}]. Opcional.
  WORK_PLACES: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return [];
      try {
        const list = JSON.parse(value);
        if (!Array.isArray(list)) throw new Error("no es una lista");
        return list.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "WORK_PLACES debe ser un JSON valido (lista de {nombre, lat, lng})" });
        return z.NEVER;
      }
    }),
  // Cuantos minutos MAS ALLA del fin declarado se mira el GPS, solo para saber si el vehiculo seguia
  // circulando. Mas minutos = mas datos por consulta; 30 alcanza para detectar un fin declarado temprano.
  STOP_TAIL_MINUTES: z.coerce.number().default(30),
  // Dias que se conservan las paradas antes de borrarse solas (limpieza diaria).
  PARADA_RETENTION_DAYS: z.coerce.number().default(90),

  // Notificaciones push al celular (Area C sin autorizacion, exceso de velocidad) via
  // Firebase Cloud Messaging - opcional a proposito: sin esto la app sigue funcionando
  // igual (la campanita web sigue mostrando las mismas alertas), solo que sin avisar
  // tambien al celular con la app cerrada. Se pega el JSON completo de la cuenta de
  // servicio en una sola linea (Firebase Console > Configuracion del proyecto >
  // Cuentas de servicio > Generar nueva clave privada), ver README.
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // Carga de servicios por chat (ver telegramAssistant.service.js) - bot privado de
  // Telegram + Claude para interpretar el mensaje en lenguaje natural. Los 3 son
  // opcionales a proposito: sin ellos, ese endpoint solo ignora los webhooks entrantes,
  // el resto de la app sigue igual.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // chat_id del grupo privado autorizado (ver /getUpdates) - cualquier otro chat que le
  // escriba al bot se ignora, ni siquiera se le contesta.
  TELEGRAM_ALLOWED_CHAT_ID: z.string().optional(),
  // Telegram manda este header en cada request al webhook (configurado al registrar la
  // URL con /setWebhook) - sin que coincida, se rechaza: evita que cualquiera que
  // adivine la URL del endpoint pueda mandar mensajes falsos.
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // Cuenta de API separada de Anthropic (console.anthropic.com), no la suscripcion de
  // Claude - factura por uso, aparte.
  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Variables de entorno invalidas:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
