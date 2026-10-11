-- Quien manejaba cuando el vehiculo supero la velocidad: el aviso le llega solo a ese chofer (no a la oficina). Columnas nuevas y opcionales:
-- los excesos ya guardados quedan sin chofer. Sin llaves foraneas a proposito: son registros de poca vida (se podan solos).
ALTER TABLE "speeding_events" ADD COLUMN "driverId" TEXT;
ALTER TABLE "speeding_events" ADD COLUMN "recordId" TEXT;
CREATE INDEX "speeding_events_driverId_occurredAt_idx" ON "speeding_events"("driverId", "occurredAt");
