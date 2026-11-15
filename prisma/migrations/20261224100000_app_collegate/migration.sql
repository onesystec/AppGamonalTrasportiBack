-- CreateEnum
CREATE TYPE "CollegamentoRuolo" AS ENUM ('FORNITORE', 'CLIENTE');

-- CreateEnum
CREATE TYPE "CollegamentoStato" AS ENUM ('IN_ATTESA', 'DA_APPROVARE', 'ATTIVO', 'RIFIUTATO', 'SCOLLEGATO');

-- AlterTable
ALTER TABLE "solicitudes_servicio" ADD COLUMN     "collegamentoId" TEXT,
ADD COLUMN     "recordRemotoId" TEXT,
ADD COLUMN     "ultimoEnviado" JSONB;

-- CreateTable
CREATE TABLE "collegamenti" (
    "id" TEXT NOT NULL,
    "ruolo" "CollegamentoRuolo" NOT NULL,
    "stato" "CollegamentoStato" NOT NULL,
    "remotoUrl" TEXT NOT NULL,
    "remotoId" TEXT,
    "remotoNome" TEXT NOT NULL,
    "remotoPartitaIva" TEXT,
    "tokenEntranteHash" TEXT,
    "tokenUscente" TEXT,
    "clientId" TEXT,
    "creadoDaId" TEXT,
    "ultimoErrore" TEXT,
    "ultimoErroreAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collegamenti_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collegamenti_clientId_key" ON "collegamenti"("clientId");

-- CreateIndex
CREATE INDEX "collegamenti_stato_idx" ON "collegamenti"("stato");

-- CreateIndex
CREATE INDEX "solicitudes_servicio_collegamentoId_idx" ON "solicitudes_servicio"("collegamentoId");

-- CreateIndex
CREATE UNIQUE INDEX "solicitudes_servicio_collegamentoId_recordRemotoId_key" ON "solicitudes_servicio"("collegamentoId", "recordRemotoId");

-- AddForeignKey
ALTER TABLE "solicitudes_servicio" ADD CONSTRAINT "solicitudes_servicio_collegamentoId_fkey" FOREIGN KEY ("collegamentoId") REFERENCES "collegamenti"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collegamenti" ADD CONSTRAINT "collegamenti_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collegamenti" ADD CONSTRAINT "collegamenti_creadoDaId_fkey" FOREIGN KEY ("creadoDaId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

