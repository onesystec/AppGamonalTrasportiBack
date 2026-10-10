-- Estilo de manejo (OneSystec) de la jornada de cada servicio. Solo columnas nuevas y opcionales.
ALTER TABLE "records" ADD COLUMN "estiloManejo" JSONB,
ADD COLUMN "estiloCalculadoAt" TIMESTAMP(3);
