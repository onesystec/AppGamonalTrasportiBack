-- Mancato pagamento: el plazo pasa a ser fecha del aviso + 13 dias para TODOS los registros
-- (tambien los importados de la app antigua / AppSheet, que traian su propia fecha limite, y
-- los ya pagados). Solo toca la tabla de mancato pagamento.
UPDATE "mancato_pagamentos"
SET "fechaVencimiento" = "fecha" + 13;

-- Con el plazo mas corto, los que se subieron despues del nuevo vencimiento (dia de Roma)
-- quedan marcados como subidos fuera de plazo. No se desmarca ninguno que ya lo estuviera.
UPDATE "mancato_pagamentos"
SET "fueraDePlazo" = true
WHERE "fueraDePlazo" = false
  AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome')::date > "fechaVencimiento";
