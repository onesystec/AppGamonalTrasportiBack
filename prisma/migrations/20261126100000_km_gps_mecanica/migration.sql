-- Mecanica: los km actuales se cuentan solos con el GPS desde la fecha del ultimo tagliando.
ALTER TABLE "vehiculos" ADD COLUMN "fechaUltimoMantenimiento" DATE,
ADD COLUMN "kmLecturaBase" DOUBLE PRECISION,
ADD COLUMN "fechaLecturaBase" DATE,
ADD COLUMN "kmGpsActualizadoAt" TIMESTAMP(3),
ADD COLUMN "kmGpsEstado" TEXT;

ALTER TABLE "mantenimientos_vehiculo" ADD COLUMN "fechaMantenimiento" DATE;

CREATE TABLE "vehiculo_km_dias" (
    "id" TEXT NOT NULL,
    "vehiculoId" TEXT NOT NULL,
    "dia" DATE NOT NULL,
    "km" DOUBLE PRECISION NOT NULL,
    "cerrado" BOOLEAN NOT NULL DEFAULT false,
    "actualizadoAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehiculo_km_dias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehiculo_km_dias_vehiculoId_dia_key" ON "vehiculo_km_dias"("vehiculoId", "dia");

ALTER TABLE "vehiculo_km_dias" ADD CONSTRAINT "vehiculo_km_dias_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "vehiculos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
