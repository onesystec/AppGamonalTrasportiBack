-- Cargo nuevo para Recursos Humanos (solo choferes, vehiculos y busta paga).
ALTER TYPE "Cargo" ADD VALUE IF NOT EXISTS 'RRHH';

-- Busta paga de cada chofer, con la firma de recepcion.
CREATE TABLE "busta_paga" (
    "id" TEXT NOT NULL,
    "choferId" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "archivoKey" TEXT NOT NULL,
    "archivoHash" TEXT NOT NULL,
    "nombreArchivo" TEXT,
    "subidaPorId" TEXT NOT NULL,
    "firmadaAt" TIMESTAMP(3),
    "firmaKey" TEXT,
    "firmaIp" TEXT,
    "firmaDispositivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "busta_paga_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "busta_paga_accesos" (
    "id" TEXT NOT NULL,
    "bustaPagaId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "ip" TEXT,
    "dispositivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "busta_paga_accesos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "busta_paga_choferId_anio_mes_key" ON "busta_paga"("choferId", "anio", "mes");
CREATE INDEX "busta_paga_choferId_anio_mes_idx" ON "busta_paga"("choferId", "anio", "mes");
CREATE INDEX "busta_paga_accesos_bustaPagaId_createdAt_idx" ON "busta_paga_accesos"("bustaPagaId", "createdAt");

ALTER TABLE "busta_paga" ADD CONSTRAINT "busta_paga_choferId_fkey" FOREIGN KEY ("choferId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "busta_paga" ADD CONSTRAINT "busta_paga_subidaPorId_fkey" FOREIGN KEY ("subidaPorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "busta_paga_accesos" ADD CONSTRAINT "busta_paga_accesos_bustaPagaId_fkey" FOREIGN KEY ("bustaPagaId") REFERENCES "busta_paga"("id") ON DELETE CASCADE ON UPDATE CASCADE;
