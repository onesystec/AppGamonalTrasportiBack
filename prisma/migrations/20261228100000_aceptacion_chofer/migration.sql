CREATE TYPE "EstadoAceptacionChofer" AS ENUM ('PENDIENTE', 'VEHICULO_PENDIENTE', 'CONFIRMADA');
ALTER TABLE "records" ADD COLUMN "aceptacionChofer" "EstadoAceptacionChofer";
