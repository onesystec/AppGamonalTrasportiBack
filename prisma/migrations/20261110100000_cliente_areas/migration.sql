-- Usuario cliente: spedizioni (areas de servicio) cuyos servicios puede seguir, ademas o en vez de su empresa.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "clienteAreas" TEXT[] DEFAULT ARRAY[]::TEXT[];

