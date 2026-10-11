-- Catalogo de peajes de Italia (OpenStreetMap), solo lectura para los mapas. Tabla nueva: no toca nada existente.
CREATE TABLE "peajes" (
    "id" TEXT NOT NULL,
    "osmId" TEXT NOT NULL,
    "nombre" TEXT,
    "operador" TEXT,
    "tipo" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "carriles" INTEGER NOT NULL DEFAULT 1,
    "importadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "peajes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "peajes_osmId_key" ON "peajes"("osmId");
CREATE INDEX "peajes_lat_lng_idx" ON "peajes"("lat", "lng");
