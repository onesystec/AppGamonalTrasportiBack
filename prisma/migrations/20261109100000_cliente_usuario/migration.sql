-- Usuarios de empresas cliente: cargo CLIENTE, su empresa y los modulos que puede ver, y el registro de avisos push enviados.
-- AlterEnum
ALTER TYPE "Cargo" ADD VALUE 'CLIENTE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "clienteId" TEXT,
ADD COLUMN     "clienteModulos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "avisos_cliente" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avisos_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "avisos_cliente_createdAt_idx" ON "avisos_cliente"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "avisos_cliente_recordId_tipo_key" ON "avisos_cliente"("recordId", "tipo");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

