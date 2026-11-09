-- Multas: la sancion por no comunicar los datos del conductor (art. 126-bis c.2) apunta a la multa original.
ALTER TABLE "multas" ADD COLUMN "multaOrigenId" TEXT;

CREATE INDEX "multas_multaOrigenId_idx" ON "multas"("multaOrigenId");

ALTER TABLE "multas" ADD CONSTRAINT "multas_multaOrigenId_fkey" FOREIGN KEY ("multaOrigenId") REFERENCES "multas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
