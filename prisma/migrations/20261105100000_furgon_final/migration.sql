-- Furgon con el que se termino el servicio cuando el mismo chofer cambio de furgon (registro + peajes/combustible del segundo furgon).
-- Columna nueva sin valor por defecto: no cambia ningun registro existente.
ALTER TABLE "records" ADD COLUMN "vehiculoFinalId" TEXT;
ALTER TABLE "records" ADD CONSTRAINT "records_vehiculoFinalId_fkey" FOREIGN KEY ("vehiculoFinalId") REFERENCES "vehiculos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
