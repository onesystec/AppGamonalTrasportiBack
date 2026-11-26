-- Servicios que la oficina cerro (entregado, anulado, reprogramado...) antes de que el chofer los aceptara:
-- el "Por aceptar" ya no aplica y bloqueaba al chofer para cargar horas, peajes y carburante.
UPDATE "records"
SET "aceptacionChofer" = NULL
WHERE "aceptacionChofer" IN ('PENDIENTE', 'VEHICULO_PENDIENTE')
  AND "estado" NOT IN ('IN_SOSPESO', 'IN_CONSEGNA', 'RITIRATO');
