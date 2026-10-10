import { romeLocalToDate } from "../utils/romeTime.js";

// Viajes compactados y regla de traspasos sin km reales: solo valen para los servicios de este dia en adelante
// (fecha del servicio, hora de Roma, "AAAA-MM-DD"). Lo anterior se calcula y se muestra como siempre.
export const VIAJES_DESDE = "2026-10-01";
export const VIAJES_DESDE_DATE = romeLocalToDate(VIAJES_DESDE, "00:00");

export const viajesAplican = (fechaServicio) => new Date(fechaServicio).getTime() >= VIAJES_DESDE_DATE.getTime();

// Km de mas en un viaje compacto (reales menos planificados): hasta ahi se reparten solos entre los servicios; por
// encima de cualquiera de los dos topes se le pregunta al chofer en que servicio fue. El front repite estos
// numeros en lib/compactado.js (KM_EXTRA_UMBRAL_*): si se cambian, cambiarlos en los dos.
export const KM_EXTRA_UMBRAL_KM = 10;
export const KM_EXTRA_UMBRAL_PCT = 0.15;
