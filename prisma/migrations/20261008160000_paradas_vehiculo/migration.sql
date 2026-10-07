-- CreateEnum
CREATE TYPE "ParadaClase" AS ENUM ('EN_CURSO', 'SERVICIO', 'COMBUSTIBLE', 'TOLERADA', 'A_REVISAR');

-- CreateTable
CREATE TABLE "paradas_vehiculo" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "targa" TEXT NOT NULL,
    "driverId" TEXT,
    "recordId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMin" INTEGER NOT NULL DEFAULT 0,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "motorApagado" BOOLEAN NOT NULL DEFAULT false,
    "clase" "ParadaClase" NOT NULL DEFAULT 'EN_CURSO',
    "motivo" TEXT,
    "distanciaServicioM" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paradas_vehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "paradas_vehiculo_vehicleId_startedAt_idx" ON "paradas_vehiculo"("vehicleId", "startedAt");

-- CreateIndex
CREATE INDEX "paradas_vehiculo_startedAt_idx" ON "paradas_vehiculo"("startedAt");

-- CreateIndex
CREATE INDEX "paradas_vehiculo_clase_idx" ON "paradas_vehiculo"("clase");

-- AddForeignKey
ALTER TABLE "paradas_vehiculo" ADD CONSTRAINT "paradas_vehiculo_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehiculos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
