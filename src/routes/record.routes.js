import { Router } from "express";
import {
  compactar,
  create,
  descompactar,
  exportRecords,
  getById,
  getLiveEta,
  list,
  listByDay,
  listByMonth,
  listPending,
  listSummaryByMonth,
  listByYear,
  ajustarKmViaje,
  circuitoMapa,
  sinSustentar,
  listCompactables,
  listSyncFailures,
  remove,
  reordenarCompactado,
  search,
  setExcepcion,
  update,
  updateDeclaraciones,
} from "../controllers/record.controller.js";
import { create as createFile, list as listFiles } from "../controllers/recordFile.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { upload } from "../middlewares/upload.js";
import { validate } from "../middlewares/validate.js";
import {
  compactadoIdParamSchema,
  compactarSchema,
  kmViajeSchema,
  createRecordSchema,
  exportRecordsQuerySchema,
  declaracionesSchema,
  excepcionSchema,
  idParamSchema,
  updateRecordSchema,
  yearMonthDayParamSchema,
  yearMonthParamSchema,
  yearParamSchema,
} from "../validators/record.validator.js";
import { createRecordFileSchema } from "../validators/recordFile.validator.js";

const router = Router();

router.use(authenticate);

router.get("/", list);

// "pending"/"search" no matchean el constraint numerico de las rutas de abajo, pero
// igual deben registrarse antes de "/:id" (mas abajo) para no chocar con el UUID.
router.get("/pending", listPending);
router.get("/search", search);
router.get("/sin-sustentar", sinSustentar);
// Servicios compactados (varios servicios de un chofer en un solo viaje): solo Admin/Responsable.
router.get("/sync-fallidos", authorize("OWNER", "ADMIN"), listSyncFailures);
router.get("/compactar/sugerencias", authorize("OWNER", "ADMIN"), listCompactables);
router.post("/compactar", authorize("OWNER", "ADMIN"), validate(compactarSchema), compactar);
router.patch(
  "/compactar/:compactadoId",
  authorize("OWNER", "ADMIN"),
  validate(compactadoIdParamSchema, "params"),
  validate(compactarSchema),
  reordenarCompactado
);
router.put(
  "/compactar/:compactadoId/km",
  authorize("OWNER", "ADMIN"),
  validate(compactadoIdParamSchema, "params"),
  validate(kmViajeSchema),
  ajustarKmViaje
);
router.delete(
  "/compactar/:compactadoId",
  authorize("OWNER", "ADMIN"),
  validate(compactadoIdParamSchema, "params"),
  descompactar
);
router.get(
  "/export",
  authorize("OWNER", "ADMIN"),
  validate(exportRecordsQuerySchema, "query"),
  exportRecords
);

// Rutas con constraint numerico: deben registrarse antes de "/:id" para no chocar con el UUID.
router.get(
  "/:year(\\d{4})/:month(\\d{1,2})/:day(\\d{1,2})",
  validate(yearMonthDayParamSchema, "params"),
  listByDay
);
// Resumen liviano (solo id/fechaServicio/estado) para armar el acordeon de dias sin
// traer stops/ruta/economico de cada registro. "summary" no matchea el regex de :day.
router.get(
  "/:year(\\d{4})/:month(\\d{1,2})/summary",
  validate(yearMonthParamSchema, "params"),
  listSummaryByMonth
);
router.get("/:year(\\d{4})/:month(\\d{1,2})", validate(yearMonthParamSchema, "params"), listByMonth);
router.get("/:year(\\d{4})", validate(yearParamSchema, "params"), listByYear);

router.post("/", authorize("OWNER", "ADMIN"), validate(createRecordSchema), create);

router.get("/:id", validate(idParamSchema, "params"), getById);
// Circuito (lugar de espera -> retiro -> paradas -> lugar de espera) con sus tramos y el recorrido, para verlo en el mapa.
router.get("/:id/circuito", validate(idParamSchema, "params"), circuitoMapa);

// A demanda desde el mapa (solo el servicio abierto/seleccionado, no todos en cada poll).
router.get(
  "/:id/eta-en-vivo",
  authorize("OWNER", "ADMIN"),
  validate(idParamSchema, "params"),
  getLiveEta
);

// Los switches de peajes y carburante del chofer: liviano a proposito (no sincroniza con AppSheet ni reasigna
// peajes), asi el cambio se ve al instante.
router.patch("/:id/declaraciones", validate(idParamSchema, "params"), validate(declaracionesSchema), updateDeclaraciones);

// Excepcion de la oficina: al servicio no se le exigen peajes ni combustible (con motivo).
router.patch("/:id/excepcion", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), validate(excepcionSchema), setExcepcion);

router.patch("/:id", validate(idParamSchema, "params"), validate(updateRecordSchema), update);

router.delete("/:id", authorize("OWNER", "ADMIN"), validate(idParamSchema, "params"), remove);

// Archivos anidados del record.
router.post(
  "/:id/files",
  validate(idParamSchema, "params"),
  upload.single("archivo"),
  validate(createRecordFileSchema),
  createFile
);
router.get("/:id/files", validate(idParamSchema, "params"), listFiles);

export default router;
