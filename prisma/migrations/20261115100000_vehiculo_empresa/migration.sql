-- De quien es cada vehiculo (Gamonal o Piazza): separa las pestanias de la lista del Mapa. Todos los actuales son de Gamonal.
-- CreateEnum
CREATE TYPE "EmpresaVehiculo" AS ENUM ('GAMONAL', 'PIAZZA');

-- AlterTable
ALTER TABLE "vehiculos" ADD COLUMN     "empresa" "EmpresaVehiculo" NOT NULL DEFAULT 'GAMONAL';
