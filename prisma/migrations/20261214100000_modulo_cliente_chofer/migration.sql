-- Nuevo modulo de usuario cliente: CHOFER (nombre del chofer en la lista de seguimiento). Se activa a los usuarios cliente que ya ven la lista
-- (hoy es el de Piazza Spedizioni); a los nuevos se les activa a mano desde "Acceso de clientes".
UPDATE "users"
SET "clienteModulos" = array_append("clienteModulos", 'CHOFER')
WHERE "cargo" = 'CLIENTE'
  AND 'LISTA' = ANY("clienteModulos")
  AND NOT ('CHOFER' = ANY("clienteModulos"));
