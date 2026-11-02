-- Circuito "estandar" del servicio (siempre por la ruta normal, con peajes): lo que se usa para pagar al chofer cuando hace falta el tiempo o los
-- km del circuito. circuitoKm / circuitoMin siguen siendo los del circuito segun lo que declaro el chofer (sin peaje = por carreteras libres, mas largo),
-- que sirven para comparar con el GPS pero ya no mueven el pago.
ALTER TABLE "records" ADD COLUMN "circuitoKmBase" DOUBLE PRECISION;
ALTER TABLE "records" ADD COLUMN "circuitoMinBase" DOUBLE PRECISION;

-- Donde el chofer no declaro "sin peaje" el circuito ya era el estandar: se copia tal cual. Los que si lo declararon se recalculan
-- (ver services/circuitoBase.service.js, al arrancar el servidor).
UPDATE "records"
SET "circuitoKmBase" = "circuitoKm", "circuitoMinBase" = "circuitoMin"
WHERE "circuitoKm" IS NOT NULL
  AND "circuito" -> 'peajes' IS NOT NULL
  AND COALESCE(("circuito" -> 'peajes' ->> 'idaSinPeaje')::boolean, false) = false
  AND COALESCE(("circuito" -> 'peajes' ->> 'vueltaSinPeaje')::boolean, false) = false;
