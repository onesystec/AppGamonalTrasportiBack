// Un servicio de Medtronic es critico solo si es AORTIC (los Medtronic "scheduled" no lo son necesariamente). La oficina lo escribe en la
// descripcion ("MEDTRONIC ASAP CON APP *AORTIC*", "Sempre Medtronic Aortic", "AORTICH"): se detecta ahi y se guarda como un dato del servicio.
export const esAortic = (descripcion) => /aortic/i.test(String(descripcion ?? ""));

// Cliente de Medtronic: en la base hay "MEDTRONIC" y tambien "METRONIC" (sin la D).
export const esMedtronic = (nombre) => /m(?:ed|e)?tronic/i.test(String(nombre ?? ""));
