-- CreateEnum
CREATE TYPE "AreaCombustible" AS ENUM ('DHL_MILANO', 'DHL_ROMA', 'EXTRAS_PIAZZA_MILANO', 'EXTRAS_PIAZZA_ROMA', 'AB_SERVICE', 'FARMACIA');

-- CreateTable
CREATE TABLE "registros_combustible" (
    "id" TEXT NOT NULL,
    "targa" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "createdById" TEXT,
    "fecha" DATE NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "metodo" TEXT NOT NULL,
    "area" "AreaCombustible" NOT NULL,
    "comprobanteKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registros_combustible_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registros_combustible_fecha_idx" ON "registros_combustible"("fecha");

-- CreateIndex
CREATE INDEX "registros_combustible_driverId_fecha_idx" ON "registros_combustible"("driverId", "fecha");

-- CreateIndex
CREATE INDEX "registros_combustible_area_fecha_idx" ON "registros_combustible"("area", "fecha");

-- AddForeignKey
ALTER TABLE "registros_combustible" ADD CONSTRAINT "registros_combustible_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehiculos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_combustible" ADD CONSTRAINT "registros_combustible_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_combustible" ADD CONSTRAINT "registros_combustible_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
