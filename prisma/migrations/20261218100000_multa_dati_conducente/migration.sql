-- Multas: comunicacion de los datos del conductor (art. 126-bis C.d.S.) para las que quitan puntos.
CREATE TYPE "DatiConducenteEstado" AS ENUM ('PENDIENTE', 'ENVIADO', 'NO_REQUERIDO');

ALTER TABLE "multas" ADD COLUMN "puntosPatente" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "multas" ADD COLUMN "datiEstado" "DatiConducenteEstado";
ALTER TABLE "multas" ADD COLUMN "datiLimite" DATE;
ALTER TABLE "multas" ADD COLUMN "datiEnviadoAt" DATE;
ALTER TABLE "multas" ADD COLUMN "datiConductor" TEXT;

CREATE INDEX "multas_datiEstado_datiLimite_idx" ON "multas"("datiEstado", "datiLimite");
