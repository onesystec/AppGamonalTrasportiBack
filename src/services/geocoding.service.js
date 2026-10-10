import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

const buildQueryKey = (direccion) => direccion.trim().toLowerCase();

// Estados de Google Geocoding API que no son un resultado valido. OVER_QUERY_LIMIT/
// UNKNOWN_ERROR pueden ser transitorios (cuota momentanea o hiccup del lado de
// Google); el resto son definitivos para esta direccion.
const NO_RESULT_STATUSES = new Set(["ZERO_RESULTS", "INVALID_REQUEST"]);

// fallbackAddress: si direccion no da resultado (ZERO_RESULTS/INVALID_REQUEST), se
// reintenta una vez con esta (pensado para la ciudad del registro) en vez de fallar
// del todo - pedido explicito del OWNER: prefiere una ubicacion aproximada (centro
// de la ciudad) a perder el servicio entero por una direccion mal cargada. No aplica
// a errores transitorios de Google (cuota, etc.), esos siguen fallando igual que antes.
const fetchFromGoogle = async (direccion, fallbackAddress) => {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", direccion);
  // Sesga (no filtra de forma estricta) resultados ambiguos hacia Italia, donde
  // opera la empresa; una direccion claramente en otro pais igual resuelve bien.
  url.searchParams.set("region", "it");
  url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);

  const response = await fetch(url);

  if (!response.ok) {
    console.error(`[geocoding] Google respondio HTTP ${response.status} para "${direccion}"`);
    throw new AppError(`No se pudo geocodificar la direccion: "${direccion}"`, 422);
  }

  const data = await response.json();

  if (data.status === "OK" && data.results?.length) {
    const [first] = data.results;
    return { lat: first.geometry.location.lat, lng: first.geometry.location.lng, raw: first };
  }

  // Se loguea el status/error_message real (cuota excedida, api key invalida, etc.)
  // para poder diagnosticar en los logs de Render sin adivinar la causa.
  console.error(
    `[geocoding] Google status=${data.status} para "${direccion}"${
      data.error_message ? ` - ${data.error_message}` : ""
    }`
  );

  if (NO_RESULT_STATUSES.has(data.status)) {
    if (fallbackAddress && buildQueryKey(fallbackAddress) !== buildQueryKey(direccion)) {
      console.warn(`[geocoding] Sin resultado para "${direccion}", aproximando con "${fallbackAddress}"`);
      return fetchFromGoogle(fallbackAddress);
    }
    throw new AppError(`No se pudo geocodificar la direccion: "${direccion}"`, 422);
  }

  // OVER_QUERY_LIMIT, REQUEST_DENIED, UNKNOWN_ERROR: problema del lado de Google
  // (cuota, api key, etc.), no de la direccion en si.
  throw new AppError(
    "No se pudo geocodificar la direccion en este momento. Intenta de nuevo en unos minutos.",
    422
  );
};

export const geocodeAddress = async (direccion, fallbackAddress) => {
  const queryKey = buildQueryKey(direccion);

  const cached = await prisma.geocodeCache.findUnique({ where: { queryKey } });
  if (cached) return { lat: cached.lat, lng: cached.lng };

  const { lat, lng, raw } = await fetchFromGoogle(direccion, fallbackAddress);

  // Se cachea bajo la queryKey de la direccion ORIGINAL (no la del fallback): la
  // proxima vez que aparezca esta misma direccion mal cargada, devuelve directo la
  // aproximacion cacheada en vez de volver a pegarle a Google.
  await prisma.geocodeCache.upsert({
    where: { queryKey },
    update: { lat, lng, raw, direccion },
    create: { queryKey, direccion, lat, lng, raw },
  });

  return { lat, lng };
};

// Geocodifica en orden secuencial (respeta el orden de las paradas). fallbackAddress
// (la ciudad del registro) se intenta para cualquier parada que no de resultado, ver
// fetchFromGoogle - si tampoco esa resuelve, recien ahi se interrumpe y propaga el
// error (dato mal cargado que no se puede aproximar ni a nivel ciudad).
// Cada parada es un texto o { direccion, lat?, lng? }: con coordenadas (sugerencia con ubicacion exacta) se usan tal
// cual, sin geocodificar.
export const geocodeStops = async (stopsInput, fallbackAddress) => {
  const stops = [];
  for (const item of stopsInput) {
    const { direccion, lat: exactLat, lng: exactLng } = typeof item === "string" ? { direccion: item } : item;
    if (exactLat != null && exactLng != null) {
      stops.push({ direccion, lat: exactLat, lng: exactLng });
      continue;
    }
    const { lat, lng } = await geocodeAddress(direccion, fallbackAddress);
    stops.push({ direccion, lat, lng });
  }
  return stops;
};
