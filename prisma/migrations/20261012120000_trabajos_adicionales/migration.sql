-- Trabajos adicionales: tareas fuera de los servicios que carga el chofer y aprueba el responsable del area.
CREATE TYPE "TrabajoAdicionalEstado" AS ENUM ('PENDIENTE', 'APROBADO', 'DEVUELTO');

CREATE TABLE "trabajos_adicionales" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "areaTipo" TEXT NOT NULL,
    "zona" TEXT,
    "areaOtros" TEXT,
    "area" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "pausaMin" INTEGER NOT NULL DEFAULT 0,
    "inicioDeclarado" TIMESTAMP(3) NOT NULL,
    "finDeclarado" TIMESTAMP(3) NOT NULL,
    "horasDia" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "horasNoche" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "descripcion" TEXT NOT NULL,
    "solicitadoPor" TEXT,
    "vehicleId" TEXT,
    "targa" TEXT,
    "sinVehiculo" BOOLEAN NOT NULL DEFAULT false,
    "km" DOUBLE PRECISION,
    "fotoKey" TEXT,
    "estado" "TrabajoAdicionalEstado" NOT NULL DEFAULT 'PENDIENTE',
    "nota" TEXT,
    "revisadoAt" TIMESTAMP(3),
    "revisadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trabajos_adicionales_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trabajos_adicionales_driverId_inicio_idx" ON "trabajos_adicionales"("driverId", "inicio");
CREATE INDEX "trabajos_adicionales_estado_area_idx" ON "trabajos_adicionales"("estado", "area");

ALTER TABLE "trabajos_adicionales" ADD CONSTRAINT "trabajos_adicionales_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trabajos_adicionales" ADD CONSTRAINT "trabajos_adicionales_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehiculos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trabajos_adicionales" ADD CONSTRAINT "trabajos_adicionales_revisadoPorId_fkey" FOREIGN KEY ("revisadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
