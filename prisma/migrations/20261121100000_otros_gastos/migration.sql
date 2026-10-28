-- Otros gastos del chofer (aceite, liquido refrigerante, lavado...): se cargan desde "Mis cargos" y la oficina los reembolsa o rechaza.
CREATE TYPE "OtroGastoEstado" AS ENUM ('PENDIENTE', 'REEMBOLSADO', 'RECHAZADO');

CREATE TABLE "otros_gastos" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "concepto" TEXT NOT NULL,
    "descripcion" TEXT,
    "monto" DECIMAL(10,2) NOT NULL,
    "fecha" DATE NOT NULL,
    "comprobanteKey" TEXT,
    "estado" "OtroGastoEstado" NOT NULL DEFAULT 'PENDIENTE',
    "nota" TEXT,
    "revisadoAt" TIMESTAMP(3),
    "revisadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "otros_gastos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "otros_gastos_driverId_fecha_idx" ON "otros_gastos"("driverId", "fecha");
CREATE INDEX "otros_gastos_estado_fecha_idx" ON "otros_gastos"("estado", "fecha");

ALTER TABLE "otros_gastos" ADD CONSTRAINT "otros_gastos_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "otros_gastos" ADD CONSTRAINT "otros_gastos_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehiculos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "otros_gastos" ADD CONSTRAINT "otros_gastos_revisadoPorId_fkey" FOREIGN KEY ("revisadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
