-- Las horas de espera de los servicios con pago por km (desde octubre de 2026) pasan por la aprobacion de un responsable: solo cuentan en el pago
-- cuando horasEstado = APROBADAS. Las esperas ya declaradas hasta ahora quedan aprobadas tal cual, para no mover lo que ya se calculo.
UPDATE "records"
SET "horasEstado" = 'APROBADAS', "horasRevisadasAt" = NOW()
WHERE "fechaServicio" >= '2026-09-30T22:00:00.000Z'
  AND COALESCE("tiempoEspera", 0) > 0
  AND ("horasEstado" IS NULL OR "horasEstado" <> 'APROBADAS');
