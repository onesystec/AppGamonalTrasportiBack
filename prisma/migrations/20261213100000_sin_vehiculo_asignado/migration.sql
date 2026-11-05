-- Los choferes ya no tienen un vehiculo propio asignado: pueden cambiar de vehiculo en cualquier momento (se usa el del servicio).
-- La columna se conserva (sin uso) por si hiciera falta consultar el historico; solo se vacian las asignaciones actuales.
UPDATE "users" SET "vehiculoAsignadoId" = NULL WHERE "vehiculoAsignadoId" IS NOT NULL;
