// Areas de servicio con las que se reparte el acceso de los Responsables. Son las mismas 6 que usa
// Registros en la app (lib/recordAreas.js del front): cada servicio cae en una sola.
export const AREA_KEYS = ["dhl-milano", "dhl-roma", "ab-service", "piazza-milano", "piazza-roma", "otros"];

export const AREA_LABELS = {
  "dhl-milano": "DHL Milano",
  "dhl-roma": "DHL Roma",
  "ab-service": "AB Service",
  "piazza-milano": "Extras Piazza Milano",
  "piazza-roma": "Extras Piazza Roma",
  otros: "Otros",
};

// Areas que trae marcadas cada sub-rol al crear al Responsable. Son solo el punto de partida: el
// Admin las cambia con los checkboxes.
export const RESPONSABLE_PRESETS = {
  MILANO_SUD: ["dhl-milano", "ab-service", "otros"],
  MILANO_NORD: ["dhl-roma", "piazza-milano", "piazza-roma"],
};

// El combustible ya guarda su area; "Farmacia" no tiene servicios propios y cae en "Otros".
export const COMBUSTIBLE_AREA_KEY = {
  DHL_MILANO: "dhl-milano",
  DHL_ROMA: "dhl-roma",
  EXTRAS_PIAZZA_MILANO: "piazza-milano",
  EXTRAS_PIAZZA_ROMA: "piazza-roma",
  AB_SERVICE: "ab-service",
  FARMACIA: "otros",
};
