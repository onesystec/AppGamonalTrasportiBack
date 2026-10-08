import { Router } from "express";
import {
  cleanupLocationPingsHandler,
  create,
  getById,
  getMyGpsRespaldoHandler,
  getReturnEtaHandler,
  getRouteHistoryHandler,
  list,
  listLocations,
  postMyGpsRespaldoLocationHandler,
  registerPushTokenHandler,
  remove,
  setMyGpsRespaldoHandler,
  unregisterPushTokenHandler,
  update,
  updateMyLocationHandler,
  updateMyLocationPermissionHandler,
  updateMyReperibilidadHandler,
  uploadAvatar,
} from "../controllers/user.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize, authorizeSelfOrRoles } from "../middlewares/authorize.js";
import { userAvatarUpload } from "../middlewares/userAvatarUpload.js";
import { validate } from "../middlewares/validate.js";
import {
  createUserSchema,
  gpsRespaldoSchema,
  idParamSchema,
  registerPushTokenSchema,
  routeHistoryParamSchema,
  unregisterPushTokenSchema,
  updateLocationPermissionSchema,
  updateLocationSchema,
  updateReperibilidadSchema,
  updateUserSchema,
} from "../validators/user.validator.js";

const router = Router();

router.use(authenticate);

router.get("/", authorize("OWNER", "ADMIN"), list);

// Rutas especificas de ubicacion: deben ir antes de "/:id" para que Express no las
// confunda con el parametro dinamico (ej. GET /ubicaciones no debe matchear GET /:id).
router.patch("/me/ubicacion", validate(updateLocationSchema), updateMyLocationHandler);
router.patch(
  "/me/ubicacion-permiso",
  validate(updateLocationPermissionSchema),
  updateMyLocationPermissionHandler
);
router.patch(
  "/me/reperibilidad",
  validate(updateReperibilidadSchema),
  updateMyReperibilidadHandler
);
router.get("/me/gps-respaldo", getMyGpsRespaldoHandler);
router.patch("/me/gps-respaldo", validate(gpsRespaldoSchema), setMyGpsRespaldoHandler);
router.post("/me/gps-respaldo/ubicacion", validate(updateLocationSchema), postMyGpsRespaldoLocationHandler);
router.get("/ubicaciones", authorize("OWNER", "ADMIN"), listLocations);

// Token de dispositivo para notificaciones push (ver pushNotification.service.js) -
// cualquier usuario logueado (no solo OWNER/ADMIN), pensado para futuros avisos
// especificos de chofer ademas de las alertas de Area C/velocidad de hoy.
router.post("/me/push-token", validate(registerPushTokenSchema), registerPushTokenHandler);
router.delete("/me/push-token", validate(unregisterPushTokenSchema), unregisterPushTokenHandler);

// Medida de optimizacion de costos (borra historial de LocationPing viejo, ver
// LOCATION_PING_RETENTION_DAYS en env.js) - solo OWNER, es un borrado en bloque e
// irreversible. Pensado para dispararse a demanda (manualmente o con un scheduler
// externo), ver README seccion "Monitoreo y costos".
router.post("/location-pings/cleanup", authorize("OWNER"), cleanupLocationPingsHandler);

router.get(
  "/:id",
  validate(idParamSchema, "params"),
  authorizeSelfOrRoles("OWNER", "ADMIN"),
  getById
);

// A demanda desde el mapa (solo el chofer libre abierto/seleccionado, no todos en cada poll).
router.get(
  "/:id/eta-regreso",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  getReturnEtaHandler
);

// Ruta real que hizo un chofer un dia puntual (ver LocationPing) - a demanda, solo
// cuando OWNER/ADMIN quiere revisar un dia especifico, no en cada poll del mapa en vivo.
router.get(
  "/:id/ruta/:year(\\d{4})/:month(\\d{1,2})/:day(\\d{1,2})",
  authorize("OWNER", "ADMIN"),
  validate(routeHistoryParamSchema, "params"),
  getRouteHistoryHandler
);

router.post("/", authorize("OWNER", "ADMIN"), validate(createUserSchema), create);

router.patch(
  "/:id",
  validate(idParamSchema, "params"),
  authorizeSelfOrRoles("OWNER", "ADMIN"),
  validate(updateUserSchema),
  update
);

router.delete(
  "/:id",
  validate(idParamSchema, "params"),
  authorize("OWNER", "ADMIN"),
  remove
);

router.post(
  "/:id/avatar",
  validate(idParamSchema, "params"),
  authorizeSelfOrRoles("OWNER", "ADMIN"),
  userAvatarUpload.single("imagen"),
  uploadAvatar
);

export default router;
