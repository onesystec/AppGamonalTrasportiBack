-- Modulo DASHBOARD del portal del cliente (resumen del mes y pendientes de hoy). Lo reciben los usuarios con Registro de las empresas con servicios directos
-- (Piazza Spedizioni); el Admin se lo puede activar o quitar a cualquier otro desde Acceso de clientes.
UPDATE "users"
SET "clienteModulos" = array_append("clienteModulos", 'DASHBOARD')
WHERE "cargo" = 'CLIENTE'
  AND 'REGISTRO' = ANY("clienteModulos")
  AND NOT ('DASHBOARD' = ANY("clienteModulos"))
  AND "clienteId" IN (SELECT "id" FROM "clients" WHERE "serviciosDirectos" = true);
