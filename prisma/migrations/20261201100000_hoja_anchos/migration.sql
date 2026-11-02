-- Ancho de las columnas de las hojas tipo Excel del portal de clientes: lo fija cualquier usuario de la empresa y lo ven todos los de esa empresa.
CREATE TABLE "hoja_anchos" (
    "id" TEXT NOT NULL,
    "alcance" TEXT NOT NULL,
    "hoja" TEXT NOT NULL,
    "anchos" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hoja_anchos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hoja_anchos_alcance_hoja_key" ON "hoja_anchos"("alcance", "hoja");
