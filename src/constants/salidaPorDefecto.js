import { DEPOT_ORIGIN } from "./depot.js";

// De donde sale (retira) un servicio cuando la oficina no escribio una "Salida": el circuito de todo servicio es lugar de
// espera -> retiro -> paradas -> lugar de espera, y el retiro depende del tipo de servicio.
//  - AB Service: retira en AB Service.
//  - DHL Roma: retira en el deposito de DHL Roma.
//  - Todo lo demas (DHL Milano, Extras...): el deposito de DHL Milano (Via Walter Tobagi), como siempre.
// Coinciden con las sugerencias de salida del frontend (SALIDA_SUGERENCIAS en lib/constants.js).
export const SALIDA_AB_SERVICE = { direccion: "AB Service", lat: 45.37563890454172, lng: 9.79930539971582 };
export const SALIDA_DHL_ROMA = { direccion: "DHL Roma", lat: 41.87714283318788, lng: 12.359177365097292 };

export const defaultSalidaFor = ({ spedizzione, extrasPiazzaZona } = {}) => {
  if (spedizzione === "AB_SERVICE") return SALIDA_AB_SERVICE;
  if (spedizzione === "DHL" && extrasPiazzaZona === "ROMA") return SALIDA_DHL_ROMA;
  return DEPOT_ORIGIN;
};
