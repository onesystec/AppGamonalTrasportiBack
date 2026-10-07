-- AlterTable
ALTER TABLE "records" ADD COLUMN "finFueraDeBase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "gpsFin" JSONB;
