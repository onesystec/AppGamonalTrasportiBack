-- Lugar donde se paso el paquete en un traspaso entre choferes (para calcular el circuito de cada uno).
-- Columna nueva sin valor por defecto: no cambia ningun registro existente.
ALTER TABLE "records" ADD COLUMN "traspasoLugar" TEXT;

-- Los servicios con traspaso (el original y su continuacion) no tienen circuito valido hasta que se indique donde se paso el
-- paquete: el que habia guardado era el del servicio entero. Se borra; se recalcula al indicar el lugar del traspaso.
UPDATE "records" SET "circuito" = NULL, "circuitoKm" = NULL
WHERE "servicioOrigenId" IS NOT NULL
   OR "id" IN (SELECT "servicioOrigenId" FROM "records" WHERE "servicioOrigenId" IS NOT NULL);
