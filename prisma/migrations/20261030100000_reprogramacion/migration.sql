-- Reprogramacion de servicios: el original conserva los km hechos y el nuevo se enlaza a el.
ALTER TABLE "records" ADD COLUMN "reprogramadoAt" TIMESTAMP(3);
ALTER TABLE "records" ADD COLUMN "reprogramacion" JSONB;
ALTER TABLE "records" ADD COLUMN "reprogramadoDeId" TEXT;
CREATE INDEX "records_reprogramadoDeId_idx" ON "records"("reprogramadoDeId");
ALTER TABLE "records" ADD CONSTRAINT "records_reprogramadoDeId_fkey" FOREIGN KEY ("reprogramadoDeId") REFERENCES "records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
