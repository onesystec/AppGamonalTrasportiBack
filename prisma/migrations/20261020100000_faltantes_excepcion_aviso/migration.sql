-- Excepcion de la oficina y aviso al chofer para los servicios con faltantes.
ALTER TABLE "records" ADD COLUMN "faltantesAvisadoAt" TIMESTAMP(3),
ADD COLUMN "faltantesExcepcion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "faltantesExcepcionNota" TEXT,
ADD COLUMN "faltantesExcepcionPor" TEXT,
ADD COLUMN "faltantesExcepcionAt" TIMESTAMP(3);
