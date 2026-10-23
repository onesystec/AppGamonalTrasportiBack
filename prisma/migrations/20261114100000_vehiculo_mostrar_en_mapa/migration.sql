-- Vehiculos que se ven en el Mapa. Los importados solos desde Velocity Fleet (area SIN_ASIGNAR, sin completar) pueden ser de otras empresas de
-- la cuenta (UNIVEX...): quedan ocultos hasta que el Admin los active a mano; el resto de los vehiculos se sigue viendo.
-- AlterTable
ALTER TABLE "vehiculos" ADD COLUMN     "mostrarEnMapa" BOOLEAN NOT NULL DEFAULT true;

UPDATE "vehiculos" SET "mostrarEnMapa" = false WHERE "area" = 'SIN_ASIGNAR';
