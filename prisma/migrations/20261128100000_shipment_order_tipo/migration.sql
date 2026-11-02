-- DHL: Shipment, Order y tipo (ASAP / SCHEDULED) del pedido, leidos del texto pegado. En el servicio y en la solicitud pendiente.
ALTER TABLE "records" ADD COLUMN "shipment" TEXT;
ALTER TABLE "records" ADD COLUMN "orderNumero" TEXT;
ALTER TABLE "records" ADD COLUMN "tipoPedido" TEXT;
CREATE INDEX "records_shipment_idx" ON "records"("shipment");
CREATE INDEX "records_orderNumero_idx" ON "records"("orderNumero");

ALTER TABLE "solicitudes_servicio" ADD COLUMN "shipment" TEXT;
ALTER TABLE "solicitudes_servicio" ADD COLUMN "orderNumero" TEXT;
ALTER TABLE "solicitudes_servicio" ADD COLUMN "tipoPedido" TEXT;
