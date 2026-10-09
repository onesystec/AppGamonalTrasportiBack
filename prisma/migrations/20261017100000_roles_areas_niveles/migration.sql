-- CreateEnum
CREATE TYPE "ResponsableTipo" AS ENUM ('MILANO_SUD', 'MILANO_NORD');

-- CreateEnum
CREATE TYPE "NivelChofer" AS ENUM ('NOVATO', 'MASTER', 'SENIOR');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "areasPermitidas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "nivelChofer" "NivelChofer",
ADD COLUMN     "responsableTipo" "ResponsableTipo";

-- AlterTable
ALTER TABLE "multas" ADD COLUMN     "area" TEXT;

-- Los Responsables que ya existian conservan lo que veian por su area anterior.
UPDATE "users" SET "areasPermitidas" = ARRAY['piazza-milano', 'piazza-roma']::TEXT[]
  WHERE "cargo" = 'ADMIN' AND "area" = 'EXTRAS_PIAZZA';
UPDATE "users" SET "areasPermitidas" = ARRAY['dhl-milano', 'dhl-roma', 'ab-service', 'otros']::TEXT[]
  WHERE "cargo" = 'ADMIN' AND "area" = 'DHL';
