-- Memorandums: comunicados formales con acuse o firma de cada destinatario antes de abrirlos.
-- CreateEnum
CREATE TYPE "MemorandumTipo" AS ENUM ('CIRCULAR', 'COMUNICACION', 'EQUIPO', 'ASIGNACION', 'VENCIMIENTO', 'SEGURIDAD', 'RECONOCIMIENTO', 'POLITICA');

-- CreateEnum
CREATE TYPE "MemorandumNivelFirma" AS ENUM ('ENTENDIDO', 'FIRMA');

-- CreateTable
CREATE TABLE "memorandums" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "secuencia" INTEGER NOT NULL,
    "tipo" "MemorandumTipo" NOT NULL,
    "titulo" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "nivelFirma" "MemorandumNivelFirma" NOT NULL,
    "emisorId" TEXT NOT NULL,
    "audiencia" TEXT NOT NULL,
    "plazoAt" TIMESTAMP(3),
    "archivoKey" TEXT NOT NULL,
    "archivoHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memorandums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memorandum_destinatarios" (
    "id" TEXT NOT NULL,
    "memorandumId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firmadaAt" TIMESTAMP(3),
    "firmaKey" TEXT,
    "firmaIp" TEXT,
    "firmaDispositivo" TEXT,
    "ultimoAvisoAt" TIMESTAMP(3),
    "avisos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memorandum_destinatarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memorandum_accesos" (
    "id" TEXT NOT NULL,
    "memorandumId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "ip" TEXT,
    "dispositivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memorandum_accesos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memorandums_numero_key" ON "memorandums"("numero");

-- CreateIndex
CREATE INDEX "memorandums_emisorId_createdAt_idx" ON "memorandums"("emisorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "memorandums_anio_secuencia_key" ON "memorandums"("anio", "secuencia");

-- CreateIndex
CREATE INDEX "memorandum_destinatarios_userId_firmadaAt_idx" ON "memorandum_destinatarios"("userId", "firmadaAt");

-- CreateIndex
CREATE UNIQUE INDEX "memorandum_destinatarios_memorandumId_userId_key" ON "memorandum_destinatarios"("memorandumId", "userId");

-- CreateIndex
CREATE INDEX "memorandum_accesos_memorandumId_createdAt_idx" ON "memorandum_accesos"("memorandumId", "createdAt");

-- AddForeignKey
ALTER TABLE "memorandums" ADD CONSTRAINT "memorandums_emisorId_fkey" FOREIGN KEY ("emisorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memorandum_destinatarios" ADD CONSTRAINT "memorandum_destinatarios_memorandumId_fkey" FOREIGN KEY ("memorandumId") REFERENCES "memorandums"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memorandum_destinatarios" ADD CONSTRAINT "memorandum_destinatarios_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memorandum_accesos" ADD CONSTRAINT "memorandum_accesos_memorandumId_fkey" FOREIGN KEY ("memorandumId") REFERENCES "memorandums"("id") ON DELETE CASCADE ON UPDATE CASCADE;

