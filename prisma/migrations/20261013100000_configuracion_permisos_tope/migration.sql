-- CreateTable
CREATE TABLE "configuracion" (
    "clave" TEXT NOT NULL,
    "valor" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracion_pkey" PRIMARY KEY ("clave")
);
