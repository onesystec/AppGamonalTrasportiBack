-- Tiempo de ruta del circuito (ida + vuelta, en minutos): base del pago de los servicios cortos.
-- Columna nueva sin valor por defecto; se rellena con lo que ya guarda el JSON "circuito".
ALTER TABLE "records" ADD COLUMN "circuitoMin" DOUBLE PRECISION;
UPDATE "records" SET "circuitoMin" = ("circuito"->>'idaMin')::double precision + ("circuito"->>'vueltaMin')::double precision
WHERE "circuito" IS NOT NULL AND "circuito"->>'idaMin' IS NOT NULL AND "circuito"->>'vueltaMin' IS NOT NULL;
