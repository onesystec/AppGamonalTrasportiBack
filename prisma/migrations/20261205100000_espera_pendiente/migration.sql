-- Todas las horas de espera declaradas desde octubre de 2026 pasan por la aprobacion de un responsable o admin (decision posterior a la migracion
-- 20261204100000_espera_aprobada, que las habia dejado aprobadas tal cual). Solo se reabren las que aprobo esa migracion, que no tienen quien las reviso
-- (horasRevisadaPorId vacio): las que ya aprobo una persona de la oficina, o cerro un Admin / Responsable sobre su propio servicio, se quedan como estan.
UPDATE "records"
SET "horasEstado" = 'PENDIENTE',
    "horasEnviadasAt" = NOW(),
    "horasRevisadasAt" = NULL,
    "horasNota" = NULL
WHERE "fechaServicio" >= '2026-09-30T22:00:00.000Z'
  AND COALESCE("tiempoEspera", 0) > 0
  AND "horasEstado" = 'APROBADAS'
  AND "horasRevisadaPorId" IS NULL;
