-- CreateEnum
CREATE TYPE "MancatoAsignacion" AS ENUM ('AUTO', 'SUGERIDO', 'CONFIRMADO', 'MANUAL', 'SIN_SERVICIO');

-- CreateEnum
CREATE TYPE "MancatoTramo" AS ENUM ('IDA', 'VUELTA');

-- AlterTable
ALTER TABLE "records" ADD COLUMN "fechaRetiro" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "mancato_pagamentos" ADD COLUMN "fechaHoraTransito" TIMESTAMP(3),
ADD COLUMN "recordId" TEXT,
ADD COLUMN "asignacion" "MancatoAsignacion" NOT NULL DEFAULT 'SIN_SERVICIO',
ADD COLUMN "tramo" "MancatoTramo",
ADD COLUMN "asignacionMotivo" TEXT;

-- CreateIndex
CREATE INDEX "mancato_pagamentos_recordId_idx" ON "mancato_pagamentos"("recordId");

-- CreateIndex
CREATE INDEX "mancato_pagamentos_vehicleId_fechaHoraTransito_idx" ON "mancato_pagamentos"("vehicleId", "fechaHoraTransito");

-- CreateIndex
CREATE INDEX "mancato_pagamentos_asignacion_idx" ON "mancato_pagamentos"("asignacion");

-- AddForeignKey
ALTER TABLE "mancato_pagamentos" ADD CONSTRAINT "mancato_pagamentos_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
