-- Interruptor por conexion (apagado por defecto): la otra app puede pedir los servicios en curso de Gamonal con su posicion.
ALTER TABLE "collegamenti" ADD COLUMN "condividiServiziInCorso" BOOLEAN NOT NULL DEFAULT false;
