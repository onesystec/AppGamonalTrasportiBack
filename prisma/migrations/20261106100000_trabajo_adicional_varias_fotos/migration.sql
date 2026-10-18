-- Trabajos adicionales: varias fotos de prueba en vez de una sola.
ALTER TABLE "trabajos_adicionales" ADD COLUMN "fotoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- La foto que ya tenian pasa a la lista nueva. "fotoKey" queda sin usar (no se borra, por si hay que volver atras).
UPDATE "trabajos_adicionales" SET "fotoKeys" = ARRAY["fotoKey"] WHERE "fotoKey" IS NOT NULL;
