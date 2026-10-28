-- Las horas fuera del horario laboral y la reperibilita ya NO se cuentan aparte por defecto: solo a quien el Admin marque en su perfil.
-- Por ahora, solo Jesus Zuniga y Luis Arroyo.
ALTER TABLE "users" ALTER COLUMN "pagaFueraHorario" SET DEFAULT false;
UPDATE "users" SET "pagaFueraHorario" = false;
UPDATE "users"
SET "pagaFueraHorario" = true
WHERE "cargo" = 'CHOFER'
  AND (
    (lower("nombre") = 'jesus' AND lower("apellido") LIKE 'zu%iga')
    OR (lower("nombre") = 'luis' AND lower("apellido") = 'arroyo')
  );
