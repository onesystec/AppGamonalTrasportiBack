-- CreateEnum
CREATE TYPE "CombustibleAsignacion" AS ENUM ('AUTO', 'SUGERIDO', 'CONFIRMADO', 'MANUAL', 'EN_ESPERA');

-- AlterTable
ALTER TABLE "registros_combustible" ADD COLUMN "fechaHora" TIMESTAMP(3),
ADD COLUMN "recordId" TEXT,
ADD COLUMN "asignacion" "CombustibleAsignacion" NOT NULL DEFAULT 'EN_ESPERA',
ADD COLUMN "asignacionMotivo" TEXT;

-- CreateIndex
CREATE INDEX "registros_combustible_recordId_idx" ON "registros_combustible"("recordId");

-- CreateIndex
CREATE INDEX "registros_combustible_vehicleId_fechaHora_idx" ON "registros_combustible"("vehicleId", "fechaHora");

-- CreateIndex
CREATE INDEX "registros_combustible_asignacion_idx" ON "registros_combustible"("asignacion");

-- AddForeignKey
ALTER TABLE "registros_combustible" ADD CONSTRAINT "registros_combustible_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
