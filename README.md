# RegistrosGTBack

Backend de gestion de personal (choferes), flota y servicios para transporte. **FASE 1**: usuarios, autenticacion JWT y roles. **FASE 2**: documentos de choferes en Cloudflare R2 (bucket privado, URLs firmadas) con compresion de imagenes via Sharp. **FASE 3**: registro de vehiculos (targa, modelo, imagen, libreto, assicurazione, poliza, revision tecnica). **FASE 4**: registro de servicios de transporte (area EXTRAS_PIAZZA) con clientes, calculo automatico de totales y archivos adjuntos.

## Stack

Node.js (ES Modules) + Express + Prisma + PostgreSQL (Neon) + JWT + bcrypt + Zod + Resend + Cloudflare R2 (S3 SDK) + Sharp + Multer.

## 1. Instalar dependencias

```bash
npm install
```

## 2. Configurar variables de entorno

Copia `.env.example` a `.env` y completa los valores:

```bash
cp .env.example .env
```

| Variable | Descripcion |
|---|---|
| `PORT` | Puerto del servidor (default 4000) |
| `NODE_ENV` | `development` \| `production` \| `test` |
| `CORS_ORIGIN` | `*` o lista de origenes separados por coma |
| `DATABASE_URL` | Connection string de Neon PostgreSQL (con `?sslmode=require`) |
| `JWT_SECRET` | Cadena aleatoria larga (`openssl rand -hex 32`) |
| `JWT_EXPIRES_IN` | Ej: `7d` |
| `RESET_TOKEN_EXPIRES_MINUTES` | Minutos de validez del token de recuperacion de contrasena |
| `RESET_PASSWORD_URL` | URL del frontend donde el usuario completa el reset (recibe `?token=`) |
| `RESEND_API_KEY` | API key de Resend |
| `RESEND_FROM_EMAIL` | Remitente verificado en Resend, ej: `RegistrosGT <no-reply@tudominio.com>` |
| `R2_ACCOUNT_ID` | Account ID de Cloudflare (dashboard > R2) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Credenciales del API Token de R2 (permiso "Object Read & Write") |
| `R2_BUCKET_NAME` | Nombre del bucket privado donde se guardan los documentos |
| `R2_SIGNED_URL_EXPIRES_SECONDS` | Minutos (en segundos) de validez de cada URL firmada, default 900 (15 min) |
| `GOOGLE_MAPS_API_KEY` | API key de Google Cloud con "Geocoding API" habilitada |
| `VELOCITY_FLEET_REFRESH_TOKEN` | Opcional. Refresh Token de la cuenta de Velocity Fleet (GPS de vehiculo, seccion Mapa) - sin esto el Mapa sigue andando igual, solo con la ubicacion del celular del chofer |
| `PHONE_LOCATION_ENABLED` | `false` por defecto: el backend ignora (sin error) la ubicacion que mande el celular del chofer y no lista ubicaciones de celulares; los ETA en vivo usan el GPS del vehiculo (Velocity Fleet). `true` para volver a usar el GPS del celular |
| `LOCATION_PING_RETENTION_DAYS` | Dias de historial de `LocationPing` que se conservan, default 90 - ver seccion "Monitoreo y costos" |
| `AREA_C_ENTRY_RETENTION_DAYS` | Dias que se conserva un `AreaCEntry` (alerta de Area C), default 3 - ver seccion "Monitoreo y costos" |
| `SPEEDING_THRESHOLD_KMH` | Velocidad (km/h) a partir de la cual se genera una alerta de exceso de velocidad, default 120 |
| `SPEEDING_DEDUP_MINUTES` | Minutos para agrupar un exceso sostenido como el mismo episodio (no una alerta nueva cada poll), default 20 |
| `SPEEDING_EVENT_RETENTION_DAYS` | Dias que se conserva un `SpeedingEvent`, default 30 - ver seccion "Monitoreo y costos" |

### Crear el bucket de Cloudflare R2

1. En el dashboard de Cloudflare, andá a **R2 Object Storage** > **Create bucket**. Nombralo (ej. `registrosgt-documentos`) y dejalo **privado** (sin acceso publico).
2. Anda a **R2 > Manage API Tokens** > **Create API Token**. Elegi permiso **Object Read & Write**, y si podes, restringilo a ese bucket especifico.
3. Copiá el **Access Key ID** y **Secret Access Key** (el secret solo se muestra una vez).
4. El **Account ID** esta en la misma pantalla de R2 (o en la URL del dashboard).
5. Completá esos 4 valores + `R2_BUCKET_NAME` en tu `.env`.

Como el bucket es privado, la API nunca expone una URL publica fija: cada vez que pedis un documento, el backend genera una URL firmada temporal (expira segun `R2_SIGNED_URL_EXPIRES_SECONDS`).

## 3. Crear la base de datos y correr las migraciones

Con `DATABASE_URL` apuntando a tu proyecto de Neon:

```bash
npx prisma migrate dev --name init
npx prisma generate
```

Esto crea la tabla `users` (enums `Area`, `Cargo`, `Estado`), la tabla `documentos` (enum `TipoDocumento`, relacionada a `users` por `usuarioId`), la tabla `vehiculos` (enum `EstadoVehiculo`), y las tablas `clients`, `records` (enum `RecordStatus`, relacionada a `users`/`vehiculos`/`clients`) y `record_files` (enum `TipoArchivoRecord`, relacionada a `records`).

## 4. Levantar el servidor

```bash
npm run dev
```

Verifica que responde en `GET http://localhost:4000/api/health`.

## 5. Probar el flujo de autenticacion (curl)

**Registro** (siempre crea un CHOFER activo, sin importar lo que se envie en `cargo`/`estado`):

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "nombre": "Juan",
    "apellido": "Perez",
    "area": "DHL",
    "fechaNacimiento": "1995-04-10",
    "numeroCelular": "+39 333 1234567",
    "correoElectronico": "juan@example.com",
    "password": "SuperSegura123"
  }'
```

**Login**:

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "correoElectronico": "juan@example.com", "password": "SuperSegura123" }'
```

Guarda el `token` de la respuesta y usalo en las siguientes llamadas:

```bash
curl http://localhost:4000/api/auth/me -H "Authorization: Bearer <TOKEN>"
```

**Recuperacion de contrasena**:

```bash
curl -X POST http://localhost:4000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{ "correoElectronico": "juan@example.com" }'
```

Revisa el email recibido (via Resend), copia el `token` del enlace y:

```bash
curl -X POST http://localhost:4000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{ "token": "<TOKEN_DEL_EMAIL>", "newPassword": "OtraSegura456" }'
```

### Convertir el primer usuario en OWNER

El registro publico siempre crea `CHOFER`. Para tener el primer `OWNER`, registra un usuario normal y luego actualiza su cargo directamente en la base de datos (unica vez, manualmente):

```bash
npx prisma studio
```

Abre la tabla `users` y cambia `cargo` a `OWNER` para tu usuario inicial. A partir de ahi, ese OWNER puede crear ADMIN/CHOFER desde `POST /api/users`.

## 6. Probar documentos (curl)

**Subir un documento** (multipart/form-data; como CHOFER, `usuarioId` se ignora y se fuerza al propio usuario; como OWNER/ADMIN es obligatorio indicarlo):

```bash
curl -X POST http://localhost:4000/api/documents \
  -H "Authorization: Bearer <TOKEN>" \
  -F "tipoDocumento=CARTA_IDENTITA" \
  -F "fechaScadenza=2030-01-01" \
  -F "archivo=@/ruta/a/tu/documento.pdf"
```

**Listar documentos** (OWNER/ADMIN pueden filtrar con `?usuarioId=`, CHOFER siempre ve solo los propios):

```bash
curl http://localhost:4000/api/documents -H "Authorization: Bearer <TOKEN>"
```

**Ver uno, actualizar metadata o reemplazar el archivo, y borrar**:

```bash
curl http://localhost:4000/api/documents/<ID> -H "Authorization: Bearer <TOKEN>"

curl -X PATCH http://localhost:4000/api/documents/<ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -F "fechaScadenza=2031-06-15"

curl -X DELETE http://localhost:4000/api/documents/<ID> -H "Authorization: Bearer <TOKEN>"
```

`archivoUrl` en la respuesta es una URL firmada temporal — se recalcula en cada request, no se persiste.

## 7. Probar vehiculos (curl)

**Crear un vehiculo** (solo OWNER/ADMIN; `imagen`, `libreto` y `assicurazione` son opcionales, se pueden cargar despues con un `PATCH`):

```bash
curl -X POST http://localhost:4000/api/vehiculos \
  -H "Authorization: Bearer <TOKEN_OWNER_O_ADMIN>" \
  -F "targa=AB123CD" \
  -F "modelo=Fiat Ducato" \
  -F "area=DHL" \
  -F "poliza=2027-03-01" \
  -F "rTecnica=2026-11-15"
```

**Completar los archivos despues** (los 3 campos son independientes, podes mandar uno, dos o los tres juntos):

```bash
curl -X PATCH http://localhost:4000/api/vehiculos/<ID> \
  -H "Authorization: Bearer <TOKEN_OWNER_O_ADMIN>" \
  -F "imagen=@/ruta/a/foto.jpg" \
  -F "libreto=@/ruta/a/libreto.pdf" \
  -F "assicurazione=@/ruta/a/assicurazione.pdf"
```

**Listar y ver el detalle** (cualquier usuario autenticado, incluido CHOFER):

```bash
curl http://localhost:4000/api/vehiculos -H "Authorization: Bearer <TOKEN>"
curl http://localhost:4000/api/vehiculos/<ID> -H "Authorization: Bearer <TOKEN>"
```

**Borrar** (solo OWNER/ADMIN; borra tambien los archivos que tenga cargados en R2):

```bash
curl -X DELETE http://localhost:4000/api/vehiculos/<ID> -H "Authorization: Bearer <TOKEN_OWNER_O_ADMIN>"
```

`imagenUrl`, `libretoUrl` y `assicurazioneUrl` son URLs firmadas temporales (o `null` si ese archivo todavia no se cargo).

## 8. Probar registros de servicios / clientes (curl)

**Crear un cliente** (solo OWNER/ADMIN; `GET` esta abierto a cualquier autenticado para el selector del frontend):

```bash
curl -X POST http://localhost:4000/api/clients \
  -H "Authorization: Bearer <TOKEN_OWNER_O_ADMIN>" -H "Content-Type: application/json" \
  -d '{ "nombre": "DHL Express" }'
```

**Crear un registro de servicio** (solo OWNER/ADMIN; `driverId` puede ser cualquier usuario ACTIVO, no solo CHOFER):

```bash
curl -X POST http://localhost:4000/api/records \
  -H "Authorization: Bearer <TOKEN_OWNER_O_ADMIN>" -H "Content-Type: application/json" \
  -d '{
    "driverId": "<ID_USUARIO>",
    "vehicleId": "<ID_VEHICULO>",
    "clientId": "<ID_CLIENTE>",
    "fechaServicio": "2026-03-15T08:00:00.000Z",
    "eta": "2026-03-15T14:00:00.000Z",
    "descripcion": "Traslado urgente",
    "codigo": "EP-2026-0001",
    "destinazione": "Torino",
    "kilometros": 500,
    "precioKm": 0.46,
    "areaC": 20,
    "costoEspera": 15,
    "costoTraforoFrejusBrennero": 40,
    "peajes": 25,
    "vignetta": 10,
    "costoHotel": 0,
    "costoCombustible": 80
  }'
```

La respuesta incluye `totalKm` (`kilometros * precioKm`) y `total` (suma de todos los costos, sin incluir `costoCombustible` ni `pagoRecibido`) — ninguno de los dos se guarda en la base, se calculan en cada respuesta.

**Filtrar por fecha** (cualquier combinacion año / año+mes / año+mes+dia):

```bash
curl http://localhost:4000/api/records/2026 -H "Authorization: Bearer <TOKEN>"
curl http://localhost:4000/api/records/2026/3 -H "Authorization: Bearer <TOKEN>"
curl http://localhost:4000/api/records/2026/3/15 -H "Authorization: Bearer <TOKEN>"
```

**Vista de un CHOFER**: si el usuario autenticado es CHOFER, `GET /api/records`, `/api/records/:year...` y `/api/records/:id` solo devuelven los registros donde el es `driverId`, y la respuesta **no incluye ningun campo economico** (`kilometros`, `precioKm`, `totalKm`, costos, `pagoRecibido`, `clienteConfirmado`, `total`). Un CHOFER puede hacer `PATCH` sobre su propio registro, pero solo se aplican estos campos si vienen en el body — cualquier otro campo se ignora silenciosamente:

```bash
curl -X PATCH http://localhost:4000/api/records/<ID> \
  -H "Authorization: Bearer <TOKEN_CHOFER>" -H "Content-Type: application/json" \
  -d '{ "horasDia": 6.5, "horasNoche": 1, "tiempoEspera": 2, "estado": "IN_CONSEGNA", "comentarios": "Todo en orden" }'
```

**Archivos del registro** (multipart/form-data; un CHOFER solo puede subir `FOTO_ENTREGA` a sus propios registros, OWNER/ADMIN pueden subir cualquier tipo a cualquier registro):

```bash
curl -X POST http://localhost:4000/api/records/<ID>/files \
  -H "Authorization: Bearer <TOKEN>" \
  -F "tipoArchivo=FOTO_ENTREGA" \
  -F "archivo=@/ruta/a/foto.jpg"

curl http://localhost:4000/api/records/<ID>/files -H "Authorization: Bearer <TOKEN>"

curl -X DELETE http://localhost:4000/api/files/<FILE_ID> -H "Authorization: Bearer <TOKEN_OWNER_O_ADMIN>"
```

## Endpoints

```
POST   /api/auth/register         publico
POST   /api/auth/login            publico
GET    /api/auth/me               autenticado
POST   /api/auth/forgot-password  publico
POST   /api/auth/reset-password   publico (requiere token valido)

GET    /api/users                 OWNER, ADMIN
GET    /api/users/:id             OWNER, ADMIN, o el propio usuario
POST   /api/users                 OWNER, ADMIN
PATCH  /api/users/:id             OWNER, ADMIN, o el propio usuario (campos limitados)
DELETE /api/users/:id             OWNER, ADMIN

POST   /api/documents             CHOFER (propio), OWNER, ADMIN (multipart/form-data)
GET    /api/documents             OWNER, ADMIN (todos, filtro ?usuarioId=); CHOFER (solo propios)
GET    /api/documents/:id         dueño del documento, OWNER, ADMIN
PATCH  /api/documents/:id         dueño del documento, OWNER, ADMIN (multipart opcional)
DELETE /api/documents/:id         dueño del documento, OWNER, ADMIN

POST   /api/vehiculos             OWNER, ADMIN (multipart/form-data, archivos opcionales)
GET    /api/vehiculos             cualquier autenticado (incluido CHOFER, solo lectura)
GET    /api/vehiculos/:id         cualquier autenticado (incluido CHOFER, solo lectura)
PATCH  /api/vehiculos/:id         OWNER, ADMIN (multipart opcional)
DELETE /api/vehiculos/:id         OWNER, ADMIN

GET    /api/clients               cualquier autenticado
POST   /api/clients               OWNER, ADMIN
PATCH  /api/clients/:id           OWNER, ADMIN
DELETE /api/clients/:id           OWNER, ADMIN

POST   /api/records                    OWNER, ADMIN
GET    /api/records                    OWNER, ADMIN (todos); CHOFER (solo propios, vista redactada)
GET    /api/records/:year              idem, filtrado por año
GET    /api/records/:year/:month       idem, filtrado por año+mes
GET    /api/records/:year/:month/:day  idem, filtrado por año+mes+dia
GET    /api/records/:id                dueño del registro (CHOFER, redactado), OWNER, ADMIN
PATCH  /api/records/:id                dueño del registro (CHOFER, campos limitados), OWNER, ADMIN (todos los campos)
DELETE /api/records/:id                OWNER, ADMIN

POST   /api/records/:id/files          dueño del registro (CHOFER, solo FOTO_ENTREGA), OWNER, ADMIN (cualquier tipo)
GET    /api/records/:id/files          dueño del registro (CHOFER), OWNER, ADMIN
DELETE /api/files/:id                  OWNER, ADMIN
```

Tipos de documento validos (`tipoDocumento`): `CARTA_IDENTITA`, `PASSAPORTO`, `SOGGIORNO`, `PATENTE`, `TRADUZIONE_PATENTE`, `CODICE_FISCALE`, `CONTRATO`, `UNILAV`, `PERMESSO_TRASPORTO`, `TREDICESIMA_QUATTORDICESIMA`, `RESPONSIVAS`.

Estados validos de vehiculo (`estado`): `DISPONIBLE`, `EN_MANTENIMIENTO`, `FUERA_DE_SERVICIO`.

Estados validos de un registro (`estado` en `Record`): `CONSEGNATO`, `IN_CONSEGNA`, `IN_SOSPESO`, `RITIRATO`, `ANNULLATO`, `RISCHEDULATO`.

Tipos de archivo validos de un registro (`tipoArchivo` en `RecordFile`): `CMR`, `FOTO_ENTREGA`, `FACTURA`, `COMPROBANTE`, `OTRO`.

Los documentos no estan atados al cargo `CHOFER`: cualquier usuario (OWNER, ADMIN o CHOFER) puede tener documentos asociados a su `usuarioId`. Lo mismo aplica a `driverId` en `Record`: no se restringe por `cargo`, solo se exige que el usuario este `ACTIVO`.

## Deploy en Render

1. Crea un nuevo **Web Service** en Render apuntando a este repositorio.
2. **Build Command**: `npm install && npx prisma generate && npx prisma migrate deploy`
3. **Start Command**: `npm start`
4. Configura en el dashboard de Render todas las variables listadas arriba (usa el `DATABASE_URL` de Neon y las credenciales reales de R2).
5. Render asigna su propio `PORT`; la app ya lee `process.env.PORT` a traves de `env.js`, no hace falta tocarlo.
6. Sharp descarga el binario correcto para Linux durante `npm install` en el build de Render automaticamente, no requiere configuracion extra.

## Estructura del proyecto

```
prisma/schema.prisma       User, Documento, Vehiculo, Client, Record, RecordFile + enums
src/
  config/                  env, prisma client, resend client, cliente R2 (S3)
  models/                  unica capa que consulta la base de datos (Prisma)
  services/                logica de negocio (auth, usuarios, documentos, vehiculos, clientes, records, storage R2)
  controllers/              capa HTTP (request/response)
  routes/                   definicion de endpoints + middlewares por ruta
  middlewares/               authenticate, authorize, validate, errorHandler, upload/vehicleUpload (multer)
  validators/                 schemas Zod
  utils/                      AppError, asyncHandler, jwt, password, resetToken, imageProcessor (Sharp), dateRange
  emails/                     plantilla del email de recuperacion de contrasena
```

## Monitoreo y costos (Neon / Velocity Fleet)

El GPS de vehiculo (Velocity Fleet, seccion Mapa) **no escribe nada en Neon**: es un
proxy en memoria del proceso (cache de 25s de las posiciones, cache de 5min del cruce
targa->vehiculo), asi que por si solo no suma storage ni filas nuevas. Los puntos de
costo reales de la app son otros, y estas son las medidas ya implementadas mas como
revisarlas:

**1. Confirmar que Neon tiene Autosuspend activo.** Es la palanca mas importante,
mucho mas que cualquier cache del codigo: mientras el compute de Neon este "despierto"
se cobra, este activo o no. En el dashboard de Neon (Settings > Compute), confirmar que
"Auto-suspend" este en un valor chico (ej. 5 min de inactividad) y no desactivado.

**2. Polling del front, pausado cuando no hace falta.** El Mapa, la campanita y demas
paginas con auto-refresco usan `startVisibleInterval` (`src/lib/polling.js` en el
front): el polling se PAUSA solo cuando la pestania pasa a segundo plano (el usuario
cambia de pestania o minimiza), y retoma al volver. Asi una pestania del Mapa olvidada
en segundo plano no mantiene a Neon despierto para siempre. El intervalo de refresco es
de 30s (`REFRESH_INTERVAL_MS` en `MapPage.jsx`), el mismo que Velocity Fleet recomienda
para su propio GPS.

**3. Cache del cruce vehiculo <-> targa.** `listVehicleLivePositionsForActor`
(`src/services/vehicle.service.js`) solo consulta la tabla de vehiculos en Neon una vez
cada 5 minutos (la flota casi no cambia en el dia a dia), no en cada poll de 30s del
Mapa. La consulta ademas trae solo `id`/`targa` (`findVehicleIdsAndTargas`), no todas
las columnas. El cache se invalida solo al crear/editar/borrar un vehiculo.

**4. Agregacion de LocationPing (historial GPS del celular del chofer).** Ya
implementado en `updateMyLocation` (`src/services/user.service.js`): solo se guarda un
punto nuevo en el historial si el chofer se movio mas de `STATIONARY_RADIUS_METERS`
desde el ultimo punto guardado - no un insert por cada ping de ubicacion del celular.

**5. Limpieza de historial viejo (retencion).** `LocationPing` no se poda solo: usar
`POST /api/users/location-pings/cleanup` (OWNER) para borrar los puntos mas viejos que
`LOCATION_PING_RETENTION_DAYS` (variable de entorno, default 90 dias). No corre solo en
el proceso (Render free se apaga por inactividad, un `setInterval` ahi no es confiable)
- hay que dispararlo desde afuera:
  - A mano de vez en cuando: `curl -X POST https://<tu-backend>/api/users/location-pings/cleanup -H "Authorization: Bearer <token de OWNER>"`.
  - O automatizado con un scheduler externo gratuito (ej. [cron-job.org](https://cron-job.org)) que le pegue a esa URL una vez por semana o por mes.

**6. Consultas reales a Velocity Fleet, monitoreadas.** `GET /api/vehiculos/velocity-fleet-usage`
(OWNER, ADMIN) devuelve cuantas consultas REALES le hicimos a la API de Velocity Fleet
(no las que salieron del cache de 25s, esas no cuestan nada) desde que arranco el
proceso - util para notar un pico anormal (ej. un bug que rompa el cache) antes de que
impacte en su factura. Tambien se loguea un resumen cada 20 consultas reales
(`[velocityFleet] N consultas reales...`) en los logs de Render.

**7. Revisar uso real.** Dashboard de Neon (Usage: compute hours, storage) y de Render
(Metrics: uptime, requests) muestran el consumo real; conviene revisarlos alguna vez
por mes mientras el GPS de vehiculo este activo, sobre todo los primeros dias.

**8. Seccion "Area C" del Mapa, sin guardar GPS continuo.** Cuando un vehiculo sin
`autorizadoAreaC` (ver el checkbox en su ficha) entra al poligono de Area C (ZTL de
Milano), se guarda UN registro liviano por dia (`AreaCEntry`: vehiculo + hora, nada de
un rastro de puntos GPS - el Area C se paga por dia completo, no por entrada) - se
detecta solo, como efecto de cada consulta a `/vehiculos/live-positions` (Mapa o
campanita de notificaciones), nunca con un proceso aparte corriendo solo. Se marca
pagada (con opcionalmente una foto del comprobante, sube a R2 igual que cualquier otro
documento) desde la seccion "Area C" del Mapa - mientras no se pague, tambien aparece
como alerta urgente en la campanita, que no se puede "descartar" a mano ahi: solo
desaparece marcandola pagada. Retencion: solo se poda lo que sigue SIN pagar, con
`POST /api/vehiculos/area-c-entries/cleanup` (OWNER) mas alla de
`AREA_C_ENTRY_RETENTION_DAYS` (default 3 dias, mismo mecanismo de scheduler externo que
el punto 5) - una vez pagada, la entrada (y su comprobante) queda de por vida, como
cualquier otro documento de la app.

**9. Alertas de exceso de velocidad, mismo criterio que Area C.** Si el GPS de un
vehiculo reporta mas de `SPEEDING_THRESHOLD_KMH` (default 120 km/h), se guarda UN
`SpeedingEvent` (vehiculo + velocidad + hora) - se agrupa como el mismo episodio si
paso hace menos de `SPEEDING_DEDUP_MINUTES` (default 20), no una fila nueva en cada
poll. Se detecta solo, como efecto de la misma consulta que Area C - ningun proceso
aparte. Es una alerta comun de la campanita (se descarta con la X normal, a diferencia
de Area C: esto es un aviso de manejo, no algo con un plazo de pago). Retencion sin
excepciones (nunca queda de por vida): `POST /api/vehiculos/speeding-events/cleanup`
(OWNER) poda todo lo mas viejo que `SPEEDING_EVENT_RETENTION_DAYS` (default 30 dias).

**10. Notificaciones push (Area C, exceso de velocidad) al celular, gratis.** Cuando se
crea un `AreaCEntry` o `SpeedingEvent` nuevo (puntos 8 y 9), se manda ademas una
notificacion push a OWNER/ADMIN via Firebase Cloud Messaging (gratis, sin limite
practico para esta escala) - la app queda avisada aunque este cerrada, no hace falta
tenerla abierta mirando la campanita. Sin costo en Neon: no agrega ninguna consulta
nueva, se dispara como efecto de la misma deteccion que ya corria (ver puntos 8 y 9), y
la tabla `PushToken` (un token por celular) es minima. Requiere `FIREBASE_SERVICE_ACCOUNT_JSON`
configurado (ver `.env.example`) - sin eso, el resto de la app sigue funcionando igual,
solo que sin avisar al celular. Pasos en Firebase (una sola vez):
  1. Crear un proyecto en [Firebase Console](https://console.firebase.google.com) (gratis, plan Spark).
  2. Agregar una app Android con el package `com.gamonaltrasporti.app` y descargar el
     `google-services.json` resultante en `AppGamonalTrasportiFront/android/app/`.
  3. En Configuracion del proyecto > Cuentas de servicio > "Generar nueva clave
     privada" - descarga un JSON. Pegar su contenido completo (en una sola linea) como
     `FIREBASE_SERVICE_ACCOUNT_JSON` en las variables de entorno de Render.

**11. Carga de servicios por chat de Telegram, con Claude interpretando el mensaje.**
Un bot privado de Telegram (solo el chat en `TELEGRAM_ALLOWED_CHAT_ID` le puede escribir
- cualquier otro mensaje se ignora en silencio) recibe el servicio en lenguaje natural,
usa la API de Claude (`telegramAssistant.service.js`) para matchear chofer/vehiculo/
cliente contra lo que ya existe en la app, repregunta lo que falte, pide confirmacion
con un resumen antes de cargar nada, y recien ahi crea el `Record` real (mismo
`createRecord` que usa el formulario del front - mismo calculo de ruta, misma escritura
a AppSheet). El hilo de la conversacion se guarda en `TelegramDraft` (una fila por chat,
se borra sola al confirmar o cancelar) porque Render free se puede dormir entre
mensajes. Costo: la API de Anthropic (cuenta separada de cualquier suscripcion de
Claude, ver `.env.example`) cobra por uso - centavos de dolar por servicio cargado a
este volumen. Requiere `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`,
`TELEGRAM_WEBHOOK_SECRET` y `ANTHROPIC_API_KEY` configurados - sin eso, el webhook
simplemente no hace nada. Pasos (una sola vez):
  1. Hablar con `@BotFather` en Telegram: `/newbot` (token), despues `/setprivacy` >
     elegir el bot > **Disable** (si no, el bot solo ve comandos/menciones, no mensajes
     normales).
  2. Crear un grupo privado con el bot adentro, mandar un mensaje cualquiera, y pegarle
     a `https://api.telegram.org/bot<token>/getUpdates` para sacar el `chat_id`
     (numero negativo) - ese va en `TELEGRAM_ALLOWED_CHAT_ID`.
  3. Generar una API key en [console.anthropic.com](https://console.anthropic.com) >
     API Keys > `ANTHROPIC_API_KEY`.
  4. Generar un secreto random para `TELEGRAM_WEBHOOK_SECRET` (ej.
     `python3 -c "import secrets; print(secrets.token_hex(24))"`).
  5. Una vez deployado con esas 4 variables, registrar el webhook:
     `curl "https://api.telegram.org/bot<token>/setWebhook" -d "url=https://<tu-backend>/api/telegram/webhook" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"`.
