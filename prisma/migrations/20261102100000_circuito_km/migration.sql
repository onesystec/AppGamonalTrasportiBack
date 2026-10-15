-- Km del circuito como columna: es la distancia con la que se paga al chofer (km / 85 = horas de manejo).
-- Columna nueva sin valor por defecto; se rellena con lo que ya guarda el JSON "circuito".
ALTER TABLE "records" ADD COLUMN "circuitoKm" DOUBLE PRECISION;
UPDATE "records" SET "circuitoKm" = ("circuito"->>'km')::double precision WHERE "circuito" IS NOT NULL AND "circuito"->>'km' IS NOT NULL;
