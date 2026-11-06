-- AlterTable
ALTER TABLE "records" ADD COLUMN "aortic" BOOLEAN NOT NULL DEFAULT false;

-- Los servicios ya cargados que dicen AORTIC en su descripcion (los Medtronic criticos) quedan marcados.
UPDATE "records" SET "aortic" = true WHERE "descripcion" ~* 'aortic';
