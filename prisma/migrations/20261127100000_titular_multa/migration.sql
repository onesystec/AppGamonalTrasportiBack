-- Multas: a nombre de quien llego el verbale (S.R.L. o ditta individuale).
CREATE TYPE "TitularMulta" AS ENUM ('SRL', 'INDIVIDUAL');

ALTER TABLE "multas" ADD COLUMN "titular" "TitularMulta";

-- Verbali de la Polizia Locale de Milano notificados por PEC a GAMONAL TRASPORTI S.R.L. (cargados el 29/10/2026).
UPDATE "multas" SET "titular" = 'SRL' WHERE "numeroVerbale" IN (
  '01881665/2026/1/1/1',
  '01881666/2026/1/1/1',
  '01892455/2026/1/1/1',
  '01940994/2026/1/1/1',
  '01941000/2026/1/1/1',
  '01957992/2026/1/1/1'
);
