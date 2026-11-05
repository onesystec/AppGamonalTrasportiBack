-- Solicitudes leidas de un texto de DHL / AB Service: calle (Ship To Address) y CAP (Ship To Postal Code) de la entrega.
ALTER TABLE "solicitudes_servicio" ADD COLUMN "calle" TEXT,
ADD COLUMN "cap" TEXT;
