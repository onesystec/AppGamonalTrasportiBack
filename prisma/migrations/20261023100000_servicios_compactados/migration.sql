-- Servicios compactados (varios servicios de un mismo chofer en un solo viaje). Solo columnas opcionales.
ALTER TABLE "records" ADD COLUMN "compactadoId" TEXT,
ADD COLUMN "compactadoOrden" INTEGER;

CREATE INDEX "records_compactadoId_idx" ON "records"("compactadoId");
