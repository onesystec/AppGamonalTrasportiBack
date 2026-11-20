-- Recursos Humanos puede ver la lista de servicios (solo lectura, sin importes) si el Owner lo activa. Apagado por defecto.
ALTER TABLE "users" ADD COLUMN "rrhhVeServicios" BOOLEAN NOT NULL DEFAULT false;
