-- Circuito planificado de un servicio (o de todo un viaje compacto, en su servicio principal): lugar de espera ->
-- retiro -> paradas -> lugar de espera. Se usa para validar horas y km. Solo una columna opcional.
ALTER TABLE "records" ADD COLUMN "circuito" JSONB;
