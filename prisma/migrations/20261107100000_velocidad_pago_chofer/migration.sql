-- Velocidad de pago por chofer y mes (85, 90 o 95 km/h): con ella se calculan las horas de manejo de los servicios de 200 km o mas.
CREATE TABLE "velocidad_pago_choferes" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "mes" TEXT NOT NULL,
    "kmh" INTEGER NOT NULL,
    "cambiadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "velocidad_pago_choferes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "velocidad_pago_choferes_driverId_mes_key" ON "velocidad_pago_choferes"("driverId", "mes");

ALTER TABLE "velocidad_pago_choferes" ADD CONSTRAINT "velocidad_pago_choferes_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
