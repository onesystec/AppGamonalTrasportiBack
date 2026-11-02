-- Cambios que un usuario cliente hace en su hoja (solicitud o servicio ya creado): historial de cada celda y alertas a la oficina
-- cuando se edita un servicio ya entregado (CONSEGNATO).
CREATE TABLE "cambios_servicio" (
    "id" TEXT NOT NULL,
    "recordId" TEXT,
    "solicitudId" TEXT,
    "campo" TEXT NOT NULL,
    "anterior" TEXT,
    "nuevo" TEXT,
    "editorId" TEXT NOT NULL,
    "editorNombre" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cambios_servicio_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cambios_servicio_recordId_createdAt_idx" ON "cambios_servicio"("recordId", "createdAt");
CREATE INDEX "cambios_servicio_solicitudId_idx" ON "cambios_servicio"("solicitudId");

CREATE TABLE "alertas_cambio" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "editorId" TEXT NOT NULL,
    "editorNombre" TEXT NOT NULL,
    "cambios" JSONB NOT NULL,
    "leidoPor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alertas_cambio_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alertas_cambio_recordId_editorId_updatedAt_idx" ON "alertas_cambio"("recordId", "editorId", "updatedAt");
CREATE INDEX "alertas_cambio_areaKey_updatedAt_idx" ON "alertas_cambio"("areaKey", "updatedAt");
