-- Pais de la entrega (codigo ISO de 2 letras; null = Italia), leido del texto del portal DHL y guardado en el servicio.
ALTER TABLE "solicitudes_servicio" ADD COLUMN "pais" TEXT;
ALTER TABLE "records" ADD COLUMN "pais" TEXT;
