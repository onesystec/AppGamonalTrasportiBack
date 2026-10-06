-- CreateTable
CREATE TABLE "mancato_pagamentos" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "targa" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "createdById" TEXT,
    "fecha" DATE NOT NULL,
    "fechaVencimiento" DATE NOT NULL,
    "costo" DECIMAL(10,2) NOT NULL,
    "sitioWeb" TEXT,
    "fotoKey" TEXT,
    "comprobanteKey" TEXT,
    "comentarios" TEXT,
    "pagado" BOOLEAN NOT NULL DEFAULT false,
    "pagadoAt" TIMESTAMP(3),
    "fueraDePlazo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mancato_pagamentos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mancato_pagamentos_numero_key" ON "mancato_pagamentos"("numero");

-- CreateIndex
CREATE INDEX "mancato_pagamentos_pagado_fechaVencimiento_idx" ON "mancato_pagamentos"("pagado", "fechaVencimiento");

-- CreateIndex
CREATE INDEX "mancato_pagamentos_driverId_idx" ON "mancato_pagamentos"("driverId");

-- CreateIndex
CREATE INDEX "mancato_pagamentos_fecha_idx" ON "mancato_pagamentos"("fecha");

-- AddForeignKey
ALTER TABLE "mancato_pagamentos" ADD CONSTRAINT "mancato_pagamentos_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehiculos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mancato_pagamentos" ADD CONSTRAINT "mancato_pagamentos_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mancato_pagamentos" ADD CONSTRAINT "mancato_pagamentos_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

