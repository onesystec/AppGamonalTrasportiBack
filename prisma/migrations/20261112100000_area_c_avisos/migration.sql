-- Area C: control de los avisos (correo unico y recordatorios push) a Responsables y Admin.
-- AlterTable
ALTER TABLE "area_c_entries" ADD COLUMN     "avisoEmailAt" TIMESTAMP(3),
ADD COLUMN     "ultimoAvisoAt" TIMESTAMP(3),
ADD COLUMN     "avisos" INTEGER NOT NULL DEFAULT 0;
