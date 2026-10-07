-- CreateEnum
CREATE TYPE "HorasEstado" AS ENUM ('PENDIENTE', 'APROBADAS', 'DEVUELTAS');

-- AlterTable
ALTER TABLE "records" ADD COLUMN "horaInicioReal" TIMESTAMP(3),
ADD COLUMN "horaFinReal" TIMESTAMP(3),
ADD COLUMN "pausaMin" INTEGER,
ADD COLUMN "horasEstado" "HorasEstado",
ADD COLUMN "horasEnviadasAt" TIMESTAMP(3),
ADD COLUMN "horasRevisadasAt" TIMESTAMP(3),
ADD COLUMN "horasRevisadaPorId" TEXT,
ADD COLUMN "horasNota" TEXT,
ADD COLUMN "horasDeclaradas" JSONB;

-- CreateIndex
CREATE INDEX "records_horasEstado_idx" ON "records"("horasEstado");

-- Las horas que ya estaban cargadas antes de este flujo se consideran aprobadas: el pago
-- historico no cambia.
UPDATE "records"
SET "horasEstado" = 'APROBADAS', "horasRevisadasAt" = NOW()
WHERE COALESCE("horasDia", 0) > 0 OR COALESCE("horasNoche", 0) > 0 OR COALESCE("tiempoEspera", 0) > 0;
