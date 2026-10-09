-- Categoria de consumo del vehiculo.
CREATE TYPE "CategoriaVehiculo" AS ENUM ('AUTO_FURGONCINO', 'H1_L1', 'H2_L2', 'CASONATO');
ALTER TABLE "vehiculos" ADD COLUMN "categoria" "CategoriaVehiculo";

-- Declaraciones del chofer: sin peaje de ida / de vuelta, sin combustible para el servicio.
ALTER TABLE "records" ADD COLUMN "sinPeajeIda" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sinPeajeVuelta" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sinCombustible" BOOLEAN NOT NULL DEFAULT false;
