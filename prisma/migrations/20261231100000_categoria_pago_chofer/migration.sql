-- Calculo por categoria (Junior, Senior, Master) por chofer y mes: solo los valores cambiados a mano en Pago a choferes.
CREATE TABLE "categoria_pago_choferes" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "mes" TEXT NOT NULL,
    "categoria" TEXT,
    "factor" INTEGER,
    "conduccion" DECIMAL(10,2),
    "reperibilidad" DECIMAL(10,2),
    "esperas" DECIMAL(10,2),
    "disponibilidad" DECIMAL(10,2),
    "productividad" DECIMAL(10,2),
    "ajuste" DECIMAL(10,2),
    "nota" TEXT,
    "cambiadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categoria_pago_choferes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "categoria_pago_choferes_driverId_mes_key" ON "categoria_pago_choferes"("driverId", "mes");

ALTER TABLE "categoria_pago_choferes" ADD CONSTRAINT "categoria_pago_choferes_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
