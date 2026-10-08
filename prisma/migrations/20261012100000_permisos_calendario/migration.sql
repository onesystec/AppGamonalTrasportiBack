-- CreateEnum
CREATE TYPE "PermisoTipo" AS ENUM ('PERMISO', 'ENFERMEDAD', 'VACACIONES', 'OTRO', 'DESCANSO');

-- CreateEnum
CREATE TYPE "PermisoEstado" AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO');

-- CreateTable
CREATE TABLE "permisos" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "tipo" "PermisoTipo" NOT NULL DEFAULT 'PERMISO',
    "fechaDesde" DATE NOT NULL,
    "fechaHasta" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    "estado" "PermisoEstado" NOT NULL DEFAULT 'PENDIENTE',
    "solicitadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creadoPorId" TEXT NOT NULL,
    "revisadoAt" TIMESTAMP(3),
    "revisadoPorId" TEXT,
    "respuesta" TEXT,

    CONSTRAINT "permisos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "permisos_driverId_fechaDesde_fechaHasta_idx" ON "permisos"("driverId", "fechaDesde", "fechaHasta");

-- CreateIndex
CREATE INDEX "permisos_estado_idx" ON "permisos"("estado");

-- AddForeignKey
ALTER TABLE "permisos" ADD CONSTRAINT "permisos_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permisos" ADD CONSTRAINT "permisos_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permisos" ADD CONSTRAINT "permisos_revisadoPorId_fkey" FOREIGN KEY ("revisadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
