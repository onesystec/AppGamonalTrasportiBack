import { Router } from "express";
import {
  cleanupAreaCEntries,
  deleteAreaCEntry,
  cleanupSpeedingEvents,
  create,
  getById,
  getEtaToDestination,
  getPushStatus,
  getSpeedingSummary,
  getVelocityFleetUsage,
  list,
  listAreaCEntries,
  listLivePositions,
  listMantenimientos,
  listSpeedingEvents,
  listUnpaidAreaCEntries,
  registerKm,
  remove,
  removeMantenimiento,
  syncVehiclesFromVelocityFleet,
  update,
  updateAreaCEntry,
} from "../controllers/vehicle.controller.js";
import { areaCEntryUpload } from "../middlewares/areaCEntryUpload.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { validate } from "../middlewares/validate.js";
import { vehicleUpload } from "../middlewares/vehicleUpload.js";
import {
  createVehicleSchema,
  etaToDestinationSchema,
  idParamSchema,
  mantenimientoIdParamSchema,
  registerKmSchema,
  speedingEventsQuerySchema,
  updateAreaCEntrySchema,
  updateVehicleSchema,
} from "../validators/vehicle.validator.js";

const router = Router();

const uploadVehicleFiles = vehicleUpload.fields([
  { name: "imagen", maxCount: 1 },
  { name: "libreto", maxCount: 1 },
  { name: "assicurazione", maxCount: 1 },
]);

router.use(authenticate);

// Lista: el chofer recibe solo id/targa/modelo (para los formularios), la oficina la ficha completa.
router.get("/", list);
// "live-positions" no matchea el UUID de "/:id" de abajo, pero igual va antes por
// las dudas (mismo criterio que "/pending"/"/search" en record.routes.js).
// Posicion en vivo de toda la flota: solo oficina.
router.get("/live-positions", authorize("OWNER", "ADMIN"), listLivePositions);
// Monitoreo de uso/costos de Velocity Fleet: solo OWNER/ADMIN (info interna, no un
// dato operativo que necesite ver un chofer).
router.get("/velocity-fleet-usage", authorize("OWNER", "ADMIN"), getVelocityFleetUsage);
// Diagnostico de notificaciones push: confirma si FIREBASE_SERVICE_ACCOUNT_JSON quedo
// bien configurado en Render sin tener que buscar en los logs.
router.get("/push-status", authorize("OWNER", "ADMIN"), getPushStatus);
// Buscador de targa del Mapa: ETA a un destino escrito a mano. OWNER/ADMIN (mismo
// publico que ve el Mapa completo).
router.post(
  "/eta-a-destino",
  authorize("OWNER", "ADMIN"),
  validate(etaToDestinationSchema),
  getEtaToDestination
);
// Seccion "Area C" del Mapa (pestanias Pagado/No pagado) + alertas sin pagar
// (campanita) + marcar pagada (con comprobante opcional) + limpieza (medida de
// optimizacion de costos, ver AREA_C_ENTRY_RETENTION_DAYS en env.js - solo OWNER, es
// un borrado en bloque e irreversible, mismo criterio que /users/location-pings/cleanup).
router.get("/area-c-entries", authorize("OWNER", "ADMIN"), listAreaCEntries);
router.get("/area-c-entries/unpaid", authorize("OWNER", "ADMIN"), listUnpaidAreaCEntries);
router.post("/area-c-entries/cleanup", authorize("OWNER"), cleanupAreaCEntries);
router.patch(
  "/area-c-entries/:id",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  areaCEntryUpload.single("comprobante"),
  validate(updateAreaCEntrySchema),
  updateAreaCEntry
);
router.delete(
  "/area-c-entries/:id",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  deleteAreaCEntry
);
// Excesos de velocidad (campanita) + su limpieza (medida de optimizacion de costos,
// ver SPEEDING_EVENT_RETENTION_DAYS en env.js) - mismo criterio que Area C arriba.
router.get(
  "/speeding-events",
  authorize("OWNER", "ADMIN"),
  validate(speedingEventsQuerySchema, "query"),
  listSpeedingEvents
);
router.get("/speeding-events/summary", authorize("OWNER", "ADMIN"), getSpeedingSummary);
router.post("/speeding-events/cleanup", authorize("OWNER"), cleanupSpeedingEvents);
// Importa a demanda las targas de Velocity Fleet que todavia no tengan ficha en la
// app (boton en Vehiculos) - solo OWNER: crea vehiculos reales con area SIN_ASIGNAR,
// no una alerta descartable, y no queremos que un ADMIN "de area" importe vehiculos
// fuera de su area sin querer.
router.post("/sync-from-velocity-fleet", authorize("OWNER"), syncVehiclesFromVelocityFleet);
// El chofer solo ve la ficha de su vehiculo (se controla en el servicio).
router.get("/:id", validate(idParamSchema, "params"), getById);

// Escritura: solo OWNER/ADMIN.
router.post("/", authorize("OWNER", "ADMIN"), uploadVehicleFiles, validate(createVehicleSchema), create);

router.patch(
  "/:id",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  uploadVehicleFiles,
  validate(updateVehicleSchema),
  update
);

router.delete("/:id", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), remove);

// Seccion Mecanica: registro de KM (deja historial) y su consulta.
router.get("/:id/mantenimiento", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), listMantenimientos);
router.post(
  "/:id/mantenimiento",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  validate(registerKmSchema),
  registerKm
);
router.delete(
  "/:id/mantenimiento/:mantenimientoId",
  authorize("OWNER", "ADMIN"),
  validate(mantenimientoIdParamSchema, "params"),
  removeMantenimiento
);

export default router;
