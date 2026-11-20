-- Multas: responsable de la oficina que gestiona cada multa.
ALTER TABLE "multas" ADD COLUMN "gestor" VARCHAR(40);

CREATE INDEX "multas_gestor_idx" ON "multas"("gestor");

-- Las recibidas desde marzo de 2026 hasta el 18/11/2026 las gestiono Yan; desde el 19/11/2026, Claudia.
UPDATE "multas" SET "gestor" = 'Yan' WHERE "fechaRecepcion" >= DATE '2026-03-01' AND "fechaRecepcion" <= DATE '2026-11-18';
UPDATE "multas" SET "gestor" = 'Claudia' WHERE "fechaRecepcion" >= DATE '2026-11-19';
