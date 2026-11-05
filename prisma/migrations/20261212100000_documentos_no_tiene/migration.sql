-- Documentos personales que cada persona marca como "no tengo" (carta d'identita, patente, etc.).
ALTER TABLE "users" ADD COLUMN "documentosNoTiene" "TipoDocumento"[] DEFAULT ARRAY[]::"TipoDocumento"[];
