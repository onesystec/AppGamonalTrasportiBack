-- Hora en que se retira el paquete cuando eso pasa antes de salir a entregarlo (informativa: las horas, el dia del servicio
-- y los peajes cuentan desde la salida, "fechaRetiro"). Solo una columna opcional.
ALTER TABLE "records" ADD COLUMN "retiroPaqueteAt" TIMESTAMP(3);
