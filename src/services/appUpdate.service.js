import { getConfig, setConfig } from "../models/permiso.model.js";
import { getSignedUrlForKey } from "./storage.service.js";

// Actualizacion del APK desde la propia app (Ajustes > Acerca de > Actualizar aplicacion). La version publicada vive en la
// tabla de configuracion y el APK en el bucket privado (R2): el endpoint devuelve una URL firmada que caduca, asi que el
// APK solo lo bajan usuarios con sesion. Se publica con scripts/publicar-apk.mjs.
export const ANDROID_CONFIG_KEY = "app.android";

// Lo publicado casi nunca cambia: se guarda unos minutos en memoria para no consultar Postgres en cada apertura de la app.
const CACHE_MS = 5 * 60 * 1000;
const SIGNED_URL_SECONDS = 30 * 60;
let cache = null;

export const invalidateAndroidUpdateCache = () => {
  cache = null;
};

const readPublished = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await getConfig(ANDROID_CONFIG_KEY);
  cache = { at: Date.now(), value: row?.valor ?? null };
  return cache.value;
};

export const getAndroidUpdate = async () => {
  const published = await readPublished();
  if (!published?.apkKey) return null;
  return {
    versionCode: published.versionCode,
    versionName: published.versionName,
    notas: published.notas ?? "",
    size: published.size,
    sha256: published.sha256,
    publicadoAt: published.publicadoAt,
    url: await getSignedUrlForKey(published.apkKey, SIGNED_URL_SECONDS),
  };
};

export const publishAndroidUpdate = async (data) => {
  await setConfig(ANDROID_CONFIG_KEY, data);
  invalidateAndroidUpdateCache();
};

export const getPublishedAndroidUpdate = async () => (await getConfig(ANDROID_CONFIG_KEY))?.valor ?? null;
