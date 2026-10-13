-- Mancato pagamento "observado": la oficina lo marca cuando no se puede pagar por algun motivo.
-- Columna nueva con valor por defecto: no cambia ningun registro existente.
ALTER TABLE "mancato_pagamentos" ADD COLUMN "observado" BOOLEAN NOT NULL DEFAULT false;
