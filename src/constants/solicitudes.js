// Tipos de servicio de una solicitud (registro limitado de un usuario cliente). Cada uno dice como queda el servicio real al aceptarla
// (spedizzione y zona) y que areas de Responsable lo ven (mismas claves que constants/areas.js).
export const SOLICITUD_SERVICIOS = {
  DHL_MILANO: { label: "DHL Milano", spedizzione: "DHL", zona: "MILANO", areaKeys: ["dhl-milano"] },
  DHL_ROMA: { label: "DHL Roma", spedizzione: "DHL", zona: "ROMA", areaKeys: ["dhl-roma"] },
  AB_SERVICE: { label: "AB Service", spedizzione: "AB_SERVICE", zona: "MILANO", areaKeys: ["ab-service"] },
  EXTRA_PIAZZA: { label: "Extra Piazza", spedizzione: "EXTRA_PIAZZA", zona: null, areaKeys: ["piazza-milano", "piazza-roma"] },
};
// Areas de Responsable que ven una solicitud: Extra Piazza depende de la zona (sin zona = Milano); los demas tipos tienen las suyas fijas.
export const areaKeysDeSolicitud = (servicio, zona) =>
  servicio === "EXTRA_PIAZZA" ? [zona === "ROMA" ? "piazza-roma" : "piazza-milano"] : (SOLICITUD_SERVICIOS[servicio]?.areaKeys ?? []);
export const SOLICITUD_SERVICIO_KEYS = Object.keys(SOLICITUD_SERVICIOS);
