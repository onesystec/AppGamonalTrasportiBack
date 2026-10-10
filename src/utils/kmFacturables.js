// Km de un servicio: lo que se carga como "km planificados" y lo que se factura.
//  - DHL, DHL Roma y AB Service: el cliente manda los km SOLO de ida (del punto de partida al de llegada), asi que se
//    cuentan x2 (ida y vuelta) y se facturan a la tarifa de DHL (0,43 EUR/km por defecto).
//  - Extras Piazza (Milano y Roma) y Extras Stefania: los km planificados se cuentan x1; el costo es
//    km x "precio por km" (que sale de la categoria del vehiculo, ver tarifas.service.js).
// Un solo criterio para todo el sistema: facturacion, diferencia contra los km reales, meta de km, litros de
// combustible exigidos y pago por distancia.

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round1 = (value) => Math.round(value * 10) / 10;

export const DHL_AB_SPEDIZZIONI = ["DHL", "AB_SERVICE"];

export const kmMultiplier = (record) => (DHL_AB_SPEDIZZIONI.includes(record?.spedizzione) ? 2 : 1);

// Km planificados x multiplicador. 0 si no hay km planificados.
export const kmFacturables = (record) => round1(num(record?.kilometros) * kmMultiplier(record));

// Km que se supone que recorrio el vehiculo: los reales si el chofer los cargo, si no los facturables y, de ultima,
// los de la ruta.
export const kmRecorrido = (record) => num(record?.kilometrosReales) || kmFacturables(record) || num(record?.rutaDistanciaKm);
