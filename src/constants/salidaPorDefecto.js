import { DEPOT_ORIGIN } from "./depot.js";
import { WORK_PLACES } from "./workPlaces.js";

// De donde sale (retira) un servicio cuando la oficina no escribio una "Salida": el circuito de todo servicio es lugar de
// espera -> retiro -> paradas -> lugar de espera, y el retiro depende del tipo de servicio.
//  - Cualquier servicio de zona Roma (DHL Roma, Extras Piazza Roma, AB Service Roma): retira en el deposito de DHL Roma.
//  - AB Service (Milano): retira en AB Service.
//  - Extras Piazza Milano: no retira en ningun deposito, va del lugar de espera directo al primer punto planificado; su "salida" es
//    el propio lugar de espera (asi el circuito no se desvia por Via Walter Tobagi).
//  - Todo lo demas (DHL Milano, Extras Stefania...): el deposito de DHL Milano (Via Walter Tobagi), como siempre.
// Coinciden con las sugerencias de salida del frontend (SALIDA_SUGERENCIAS en lib/constants.js).
export const SALIDA_AB_SERVICE = { direccion: "AB Service", lat: 45.37563890454172, lng: 9.79930539971582 };
const ESPERA_MILANO = WORK_PLACES.find((p) => p.nombre === "Lugar de espera Milano");
export const SALIDA_ESPERA_MILANO = { direccion: ESPERA_MILANO.nombre, lat: ESPERA_MILANO.lat, lng: ESPERA_MILANO.lng };
export const SALIDA_DHL_ROMA = { direccion: "DHL Roma", lat: 41.87714283318788, lng: 12.359177365097292 };

export const defaultSalidaFor = ({ spedizzione, extrasPiazzaZona } = {}) => {
  if (extrasPiazzaZona === "ROMA" && ["DHL", "AB_SERVICE", "EXTRA_PIAZZA"].includes(spedizzione)) return SALIDA_DHL_ROMA;
  if (spedizzione === "AB_SERVICE") return SALIDA_AB_SERVICE;
  // Extras Piazza (los historicos sin tipo, spedizzione null, tambien lo son) de Milano.
  if ((spedizzione === "EXTRA_PIAZZA" || spedizzione === null) && extrasPiazzaZona !== "ROMA") return SALIDA_ESPERA_MILANO;
  return DEPOT_ORIGIN;
};
