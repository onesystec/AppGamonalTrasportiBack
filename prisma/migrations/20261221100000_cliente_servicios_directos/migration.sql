-- Empresas cliente cuyos servicios entran directo al Registro (sin pasar por solicitud pendiente).
ALTER TABLE "clients" ADD COLUMN "serviciosDirectos" BOOLEAN NOT NULL DEFAULT false;

-- Piazza Spedizioni: sus servicios ya no pasan por solicitud.
UPDATE "clients" SET "serviciosDirectos" = true WHERE "nombre" ILIKE '%piazza%';
