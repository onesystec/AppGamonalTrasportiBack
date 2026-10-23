-- Recorrido real de cada servicio comparado con el plan (GPS de OneSystec): resumen, linea simplificada y marca REVISAR/OK.
-- AlterTable
ALTER TABLE "records" ADD COLUMN     "recorridoEstado" TEXT;

-- CreateTable
CREATE TABLE "recorridos_reales" (
    "recordId" TEXT NOT NULL,
    "resumen" JSONB NOT NULL,
    "geometria" JSONB,
    "calculadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recorridos_reales_pkey" PRIMARY KEY ("recordId")
);

-- AddForeignKey
ALTER TABLE "recorridos_reales" ADD CONSTRAINT "recorridos_reales_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

