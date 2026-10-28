-- Casilla del perfil del chofer (solo Admin): si las horas fuera del horario laboral y la reperibilita se cuentan aparte del basico.
-- Por defecto si (es como se pagaba hasta ahora).
ALTER TABLE "users" ADD COLUMN "pagaFueraHorario" BOOLEAN NOT NULL DEFAULT true;
