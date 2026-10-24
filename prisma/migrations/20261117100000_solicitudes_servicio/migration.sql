-- CreateEnum
CREATE TYPE "SolicitudServicioTipo" AS ENUM ('DHL_MILANO', 'DHL_ROMA', 'AB_SERVICE', 'EXTRA_PIAZZA');

-- CreateEnum
CREATE TYPE "SolicitudEstado" AS ENUM ('PENDIENTE', 'ACEPTADA', 'RECHAZADA');

-- CreateTable
CREATE TABLE "solicitudes_servicio" (
    "id" TEXT NOT NULL,
    "creadoPorId" TEXT NOT NULL,
    "empresaId" TEXT,
    "servicio" "SolicitudServicioTipo" NOT NULL,
    "cliente" TEXT NOT NULL,
    "destinazione" TEXT NOT NULL,
    "fechaHora" TIMESTAMP(3) NOT NULL,
    "km" DOUBLE PRECISION,
    "pagato" DOUBLE PRECISION,
    "varie" TEXT,
    "varie2" TEXT,
    "aplicativo" "Aplicativo",
    "estado" "SolicitudEstado" NOT NULL DEFAULT 'PENDIENTE',
    "motivoRechazo" TEXT,
    "revisadoPorId" TEXT,
    "revisadoAt" TIMESTAMP(3),
    "recordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solicitudes_servicio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "solicitudes_servicio_recordId_key" ON "solicitudes_servicio"("recordId");

-- CreateIndex
CREATE INDEX "solicitudes_servicio_estado_fechaHora_idx" ON "solicitudes_servicio"("estado", "fechaHora");

-- CreateIndex
CREATE INDEX "solicitudes_servicio_creadoPorId_idx" ON "solicitudes_servicio"("creadoPorId");

-- CreateIndex
CREATE INDEX "solicitudes_servicio_empresaId_idx" ON "solicitudes_servicio"("empresaId");

-- AddForeignKey
ALTER TABLE "solicitudes_servicio" ADD CONSTRAINT "solicitudes_servicio_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_servicio" ADD CONSTRAINT "solicitudes_servicio_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_servicio" ADD CONSTRAINT "solicitudes_servicio_revisadoPorId_fkey" FOREIGN KEY ("revisadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_servicio" ADD CONSTRAINT "solicitudes_servicio_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

