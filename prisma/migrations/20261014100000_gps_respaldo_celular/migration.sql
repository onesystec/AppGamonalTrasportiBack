-- AlterTable
ALTER TABLE "users" ADD COLUMN "gpsRespaldoPermitido" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "gpsRespaldoPermitidoAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "location_pings" ADD COLUMN "respaldo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "paradas_vehiculo" ADD COLUMN "fuente" TEXT NOT NULL DEFAULT 'VEHICULO';
