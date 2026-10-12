-- Servicios al exterior de Italia que pasan primero por Brennero: la ruta (km y tiempo) lleva ese punto de paso.
ALTER TABLE "records" ADD COLUMN "pasaPorBrennero" BOOLEAN NOT NULL DEFAULT false;
