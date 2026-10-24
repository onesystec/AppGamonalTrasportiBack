-- Solicitudes de servicio: columnas del Excel mensual de Piazza (Fornitore, Aut. ritiro, Pagato al 50%, KM como texto, descripcion) y Varie 2 como importe.
ALTER TABLE "solicitudes_servicio" ADD COLUMN "kmTexto" TEXT;
ALTER TABLE "solicitudes_servicio" ADD COLUMN "pagato50" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "solicitudes_servicio" ADD COLUMN "fornitore" TEXT NOT NULL DEFAULT 'Gamonal';
ALTER TABLE "solicitudes_servicio" ADD COLUMN "autRitiro" TEXT;
ALTER TABLE "solicitudes_servicio" ADD COLUMN "descripcion" TEXT;

-- Varie 2 pasa de texto a importe: se conserva solo si lo escrito era un numero.
ALTER TABLE "solicitudes_servicio" ALTER COLUMN "varie2" TYPE DOUBLE PRECISION
  USING CASE WHEN "varie2" ~ '^\s*[0-9]+([.,][0-9]+)?\s*$' THEN replace(trim("varie2"), ',', '.')::double precision ELSE NULL END;
