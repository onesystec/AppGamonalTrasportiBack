-- Servicios directos por usuario cliente: hay usuarios (Piazza Spedizioni) que acceden solo por spedizioni, sin empresa, y el interruptor de la empresa no les llegaba.
ALTER TABLE "users" ADD COLUMN "serviciosDirectos" BOOLEAN NOT NULL DEFAULT false;

-- Los usuarios cliente de Piazza con Registro pasan a servicios directos.
UPDATE "users" SET "serviciosDirectos" = true
WHERE "cargo" = 'CLIENTE'
  AND 'REGISTRO' = ANY("clienteModulos")
  AND ("correoElectronico" ILIKE '%piazza%' OR "nombre" ILIKE '%piazza%' OR "apellido" ILIKE '%piazza%');

-- El interruptor de empresa se activo por error en fichas que no son la empresa de ningun usuario cliente (por ejemplo el cliente final "EXTRA PIAZZA"): se apaga.
UPDATE "clients" c SET "serviciosDirectos" = false
WHERE c."serviciosDirectos" = true
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."clienteId" = c."id" AND u."cargo" = 'CLIENTE');
