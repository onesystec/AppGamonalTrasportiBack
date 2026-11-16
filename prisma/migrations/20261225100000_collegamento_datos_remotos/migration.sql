-- Ultimo servicio tal como lo mando la app conectada (App Piazza): para detectar y anotar lo que cambia cuando lo vuelve a mandar.
ALTER TABLE "solicitudes_servicio" ADD COLUMN "datosRemotos" JSONB;
