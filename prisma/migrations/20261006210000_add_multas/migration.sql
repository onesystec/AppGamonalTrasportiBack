-- CreateEnum
CREATE TYPE "QuienPagaMulta" AS ENUM ('CHOFER_PAGO', 'A_DESCONTAR');

-- CreateTable
CREATE TABLE "multas" (
    "id" TEXT NOT NULL,
    "numeroVerbale" TEXT NOT NULL,
    "targa" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "createdById" TEXT,
    "fechaRecepcion" DATE NOT NULL,
    "fechaVencimiento" DATE NOT NULL,
    "costo" DECIMAL(10,2) NOT NULL,
    "quienPaga" "QuienPagaMulta" NOT NULL,
    "descontado" BOOLEAN NOT NULL DEFAULT false,
    "descontadoAt" TIMESTAMP(3),
    "comentarios" TEXT,
    "multaKey" TEXT,
    "comprobanteKey" TEXT,
    "pagado" BOOLEAN NOT NULL DEFAULT false,
    "pagadoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "multas_numeroVerbale_key" ON "multas"("numeroVerbale");

-- CreateIndex
CREATE INDEX "multas_pagado_fechaVencimiento_idx" ON "multas"("pagado", "fechaVencimiento");

-- CreateIndex
CREATE INDEX "multas_driverId_idx" ON "multas"("driverId");

-- CreateIndex
CREATE INDEX "multas_fechaRecepcion_idx" ON "multas"("fechaRecepcion");

-- CreateIndex
CREATE INDEX "multas_quienPaga_descontado_idx" ON "multas"("quienPaga", "descontado");

-- AddForeignKey
ALTER TABLE "multas" ADD CONSTRAINT "multas_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehiculos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multas" ADD CONSTRAINT "multas_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multas" ADD CONSTRAINT "multas_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

