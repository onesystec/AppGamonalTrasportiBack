import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("*"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatorio"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // Clave compartida con OneSystec para el acceso directo (single sign-on): OneSystec firma un ticket de 60 s con
  // esta clave y POST /api/auth/sso lo cambia por una sesion, sin password. Debe ser EXACTAMENTE el mismo valor que
  // SSO_SHARED_SECRET en el backend de OneSystec. Sin ella ese endpoint responde 503 y el resto de la app anda igual.
  SSO_SHARED_SECRET: z.string().min(16, "SSO_SHARED_SECRET debe tener al menos 16 caracteres").optional(),

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
  // Ruta "sin peaje" (cuando el chofer declara que no uso peaje): OSRM publico no puede evitarlos, Valhalla si (use_tolls=0). Por
  // defecto el servidor publico de FOSSGIS (uso razonable, sin garantias); se puede apuntar a uno propio.
  VALHALLA_BASE_URL: z.string().url().default("https://valhalla1.openstreetmap.de"),

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
      (types) => types.every((t) => ["CMR", "BOLLA", "FOTO_ENTREGA", "FACTURA", "COMPROBANTE", "OTRO"].includes(t)),
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
  // Estimacion por ruta (sin GPS): tiempo que se supone en cada parada (minutos), recargo por trafico sobre el
  // tiempo de OSRM (que no lo incluye) y descanso que se supone cada X minutos de conduccion.
  ESTIMATE_STOP_MIN: z.coerce.number().default(10),
  ESTIMATE_TRAFFIC_FACTOR: z.coerce.number().default(1.15),
  ESTIMATE_BREAK_EVERY_MIN: z.coerce.number().default(270),
  ESTIMATE_BREAK_MIN: z.coerce.number().default(30),
  // Seguimiento (mapa y avisos de la oficina): un servicio con mas de estas horas de retraso sobre su ETA se da por olvidado (sigue "en camino" porque nadie
  // lo cerro) y no se muestra ni genera avisos; la oficina lo ve con "Ver antiguos". Los clientes tienen su propio limite (12 h).
  SEGUIMIENTO_MAX_RETRASO_HORAS: z.coerce.number().min(1).default(6),
  // GPS de respaldo del celular del chofer: si el GPS del vehiculo (OneSystec) esta bloqueado o caido,
  // los choferes que lo autorizaron comparten su ubicacion SOLO durante sus servicios y las paradas se
  // calculan con eso (ver gpsHealth.service.js y gpsRespaldo.service.js). "false" lo apaga del todo.
  // Revision en segundo plano (cada 2 min, de 05:00 a 23:00 de Roma) de los servicios en camino para mandar los avisos del
  // seguimiento aunque nadie tenga el mapa abierto. Mantiene la base despierta (Neon cobra por hora despierta), por eso
  // viene apagada: con "false" los avisos solo salen cuando alguien de la oficina tiene la app abierta. "true" la enciende.
  SEGUIMIENTO_MONITOR_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  GPS_RESPALDO_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
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

  // Minutos despues de la hora de retiro (fechaRetiro) en que un servicio todavia "Pendiente" pasa solo a "En camino". 0 = apagado.
  AUTO_EN_CAMINO_MIN: z.coerce.number().min(0).default(15),
  // Pausa nocturna de esa tarea (hora de Roma, "HH:MM-HH:MM"): no consulta la base en esas horas, asi Neon se duerme y no cobra computo. Los
  // servicios que salgan dentro de la pausa pasan a "En camino" al terminar (se pone al dia solo). Vacio = sin pausa (corre las 24 h).
  // Con los servicios de 2026 no sale ninguno entre las 23:15 y las 04:00, asi que "00:00-04:00" no cambia nada para nadie.
  AUTO_EN_CAMINO_PAUSA: z.string().default("00:00-04:00"),

  // Area C sin autorizacion (ver areaCAvisos.service.js): aviso por push y por correo a los Responsables y al Admin cuando un vehiculo
  // entra, y recordatorios por push hasta que se marque como pagada.
  //  - AREA_C_PLAZO_DIAS: dias para pagar sin recargo; 1 = hasta las 23:59 (Roma) del dia siguiente a la entrada.
  //  - AREA_C_RECORDATORIO_MIN: cada cuantos minutos se repite el recordatorio mientras sobra tiempo; AREA_C_RECORDATORIO_URGENTE_MIN: lo
  //    mismo cuando faltan AREA_C_URGENTE_HORAS horas o menos para el plazo. AREA_C_RECORDATORIO_MAX_DIAS: pasados estos dias desde la
  //    entrada ya no se insiste.
  //  - AREA_C_SILENCIO: ventana "HH:MM-HH:MM" (hora de Roma) sin recordatorios; los pendientes salen al terminar. Vacio = sin silencio.
  //  - AREA_C_MONITOR_ENABLED: revisa la posicion de la flota cada 3 minutos (lunes a viernes de 07:30 a 19:30) aunque nadie tenga el mapa abierto.
  //  - APP_URL: direccion publica de la app (boton y logo del correo).
  // Memorandums (ver memorandumAvisos.service.js): recordatorios por push a quienes todavia no confirmaron.
  //  - MEMO_RECORDATORIO_HORAS: cada cuantas horas se repite; MEMO_RECORDATORIO_URGENTE_HORAS: lo mismo cuando falta un dia o menos para el
  //    plazo (o ya paso). MEMO_RECORDATORIO_MAX_DIAS: pasados estos dias desde la emision ya no se insiste.
  //  - MEMO_SILENCIO: ventana "HH:MM-HH:MM" (hora de Roma) sin recordatorios. Vacio = sin silencio.
  MEMO_RECORDATORIO_HORAS: z.coerce.number().min(1).default(6),
  MEMO_RECORDATORIO_URGENTE_HORAS: z.coerce.number().min(1).default(3),
  MEMO_RECORDATORIO_MAX_DIAS: z.coerce.number().min(1).default(14),
  MEMO_SILENCIO: z.string().default("20:00-08:00"),

  AREA_C_PLAZO_DIAS: z.coerce.number().int().min(0).default(1),
  AREA_C_RECORDATORIO_MIN: z.coerce.number().min(15).default(120),
  AREA_C_RECORDATORIO_URGENTE_MIN: z.coerce.number().min(15).default(60),
  AREA_C_URGENTE_HORAS: z.coerce.number().min(0).default(6),
  AREA_C_RECORDATORIO_MAX_DIAS: z.coerce.number().min(1).default(7),
  AREA_C_SILENCIO: z.string().default("21:00-07:30"),
  AREA_C_MONITOR_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  APP_URL: z.string().url().default("https://app-gamonal-trasporti-front.vercel.app"),

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
  // Clave con la que GitHub Actions publica un APK nuevo (POST /api/app/android/publicar). Sin ella ese endpoint queda apagado.
  APP_PUBLISH_TOKEN: z.string().min(32, "APP_PUBLISH_TOKEN debe tener al menos 32 caracteres").optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // chat_id del grupo privado autorizado (ver /getUpdates) - cualquier otro chat que le
  // escriba al bot se ignora, ni siquiera se le contesta.
  TELEGRAM_ALLOWED_CHAT_ID: z.string().optional(),
  // Telegram manda este header en cada request al webhook (configurado al registrar la
  // URL con /setWebhook) - sin que coincida, se rechaza: evita que cualquiera que
  // adivine la URL del endpoint pueda mandar mensajes falsos.
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // Quien es cada persona del grupo: JSON { "<id de Telegram>": "<correo del usuario en el app>" }. Con esto el servicio se carga
  // "como" ese usuario (un Responsable solo carga en sus areas) y se sabe quien lo cargo. Vacio = cualquiera del grupo carga.
  TELEGRAM_USER_MAP: z.string().optional(),
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
