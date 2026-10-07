-- AlterTable
ALTER TABLE "records" ADD COLUMN "servicioOrigenId" TEXT,
ADD COLUMN "traspasoHora" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "records_servicioOrigenId_idx" ON "records"("servicioOrigenId");

-- AddForeignKey
ALTER TABLE "records" ADD CONSTRAINT "records_servicioOrigenId_fkey" FOREIGN KEY ("servicioOrigenId") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
