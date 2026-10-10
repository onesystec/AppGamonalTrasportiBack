-- Reparto de los km reales de un viaje compacto entre sus servicios (quien lo indico, que servicios tuvieron km de
-- mas, nota). Se guarda en el servicio principal. Solo una columna opcional.
ALTER TABLE "records" ADD COLUMN "kmReparto" JSONB;
