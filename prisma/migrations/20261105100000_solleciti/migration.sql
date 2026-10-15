-- Solleciti (solicitos de la autopista): tabla nueva, no toca ninguna existente.
CREATE TYPE "SollecitoEstado" AS ENUM ('POR_PAGAR', 'PAGADO', 'NO_CORRESPONDE');

CREATE TABLE "solleciti" (
    "id" TEXT NOT NULL,
    "emisor" TEXT NOT NULL,
    "numeroAtto" TEXT NOT NULL,
    "fechaCarta" DATE,
    "fechaTransito" DATE,
    "targa" TEXT,
    "numerosMancato" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importe" DECIMAL(10,2),
    "sitioPago" TEXT,
    "archivoKey" TEXT,
    "comprobanteKey" TEXT,
    "estado" "SollecitoEstado" NOT NULL DEFAULT 'POR_PAGAR',
    "pagadoAt" TIMESTAMP(3),
    "comentarios" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solleciti_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "solleciti_numeroAtto_key" ON "solleciti"("numeroAtto");
CREATE INDEX "solleciti_estado_idx" ON "solleciti"("estado");
CREATE INDEX "solleciti_fechaCarta_idx" ON "solleciti"("fechaCarta");
