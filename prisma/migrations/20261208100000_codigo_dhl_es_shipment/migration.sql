-- El codigo de un servicio DHL pasa a ser su Shipment (como en Extras Piazza). Solo se cambian los codigos que la app genero sola ("DHL-" + marca de
-- tiempo) en servicios que ya tienen Shipment, cuando ese Shipment no esta repetido en otro servicio ni ya usado como codigo.
UPDATE "records" r
SET "codigo" = btrim(r."shipment")
WHERE r."spedizzione" = 'DHL'
  AND r."shipment" IS NOT NULL
  AND btrim(r."shipment") <> ''
  AND r."codigo" ~ '^DHL-[0-9]{10,}$'
  AND NOT EXISTS (SELECT 1 FROM "records" o WHERE o."codigo" = btrim(r."shipment"))
  AND (SELECT COUNT(*) FROM "records" d WHERE d."spedizzione" = 'DHL' AND btrim(d."shipment") = btrim(r."shipment") AND d."codigo" ~ '^DHL-[0-9]{10,}$') = 1;
