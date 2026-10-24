// Tipos de servicio de una solicitud (registro limitado de un usuario cliente). Cada uno dice como queda el servicio real al aceptarla
// (spedizzione y zona) y que areas de Responsable lo ven (mismas claves que constants/areas.js).
export const SOLICITUD_SERVICIOS = {
  DHL_MILANO: { label: "DHL Milano", spedizzione: "DHL", zona: "MILANO", areaKeys: ["dhl-milano"] },
  DHL_ROMA: { label: "DHL Roma", spedizzione: "DHL", zona: "ROMA", areaKeys: ["dhl-roma"] },
  AB_SERVICE: { label: "AB Service", spedizzione: "AB_SERVICE", zona: "MILANO", areaKeys: ["ab-service"] },
  EXTRA_PIAZZA: { label: "Extra Piazza", spedizzione: "EXTRA_PIAZZA", zona: null, areaKeys: ["piazza-milano", "piazza-roma"] },
};
export const SOLICITUD_SERVICIO_KEYS = Object.keys(SOLICITUD_SERVICIOS);
