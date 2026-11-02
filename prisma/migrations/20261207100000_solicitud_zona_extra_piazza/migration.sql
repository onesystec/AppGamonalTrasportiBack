-- Solicitudes de Extra Piazza: Milano o Roma (cada una sale de su propio lugar de espera). null = Milano.
ALTER TABLE "solicitudes_servicio" ADD COLUMN "zona" "ExtrasPiazzaZona";
