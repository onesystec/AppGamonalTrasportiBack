// Tarifas por km (EUR/km) con las que se arma el "precio por km" de un servicio nuevo. Se pueden cambiar desde la app
// (Finanzas > Tarifas por km): estos valores son los iniciales y los que se usan si nunca se guardo nada.
//  - Extras Piazza: segun la categoria del vehiculo (ver CATEGORIAS_VEHICULO en config/faltantes.js).
//  - DHL, DHL Roma y AB Service: una sola tarifa, aplicada a los km x2.
export const TARIFAS_KM_DEFAULT = {
  AUTO_FURGONCINO: 0.45,
  H1_L1: 0.48,
  H2_L2: 0.5,
  CASONATO: 0.6,
  DHL_AB: 0.43,
};
export const TARIFAS_KM_KEYS = Object.keys(TARIFAS_KM_DEFAULT);
