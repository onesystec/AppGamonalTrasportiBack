ALTER TABLE "records" ADD COLUMN "aceptadoChoferAt" TIMESTAMP(3);

CREATE TABLE "declaraciones_vehiculo" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "targa" TEXT,
    "modelo" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "declaraciones_vehiculo_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "declaraciones_vehiculo_driverId_fecha_idx" ON "declaraciones_vehiculo"("driverId", "fecha");
ALTER TABLE "declaraciones_vehiculo" ADD CONSTRAINT "declaraciones_vehiculo_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
