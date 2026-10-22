-- Servicio que pasa por el tunel de Frejus (hacia Francia), ademas de Brennero.
-- AlterTable
ALTER TABLE "records" ADD COLUMN     "pasaPorFrejus" BOOLEAN NOT NULL DEFAULT false;
