import { TARIFAS_KM_DEFAULT, TARIFAS_KM_KEYS } from "../config/tarifasKm.js";
import { getConfig, setConfig } from "../models/permiso.model.js";
import { DHL_AB_SPEDIZZIONI } from "../utils/kmFacturables.js";

const CLAVE = "tarifas.km";
const CACHE_MS = 60 * 1000;
let cache = null;

const merge = (saved) =>
  Object.fromEntries(TARIFAS_KM_KEYS.map((key) => [key, typeof saved?.[key] === "number" ? saved[key] : TARIFAS_KM_DEFAULT[key]]));

export const getTarifasKm = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await getConfig(CLAVE);
  const value = merge(row?.valor);
  cache = { at: Date.now(), value };
  return value;
};

export const setTarifasKm = async (values) => {
  const current = await getTarifasKm();
  const next = merge({ ...current, ...Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "number")) });
  await setConfig(CLAVE, next);
  cache = { at: Date.now(), value: next };
  return next;
};

// "Precio por km" de un servicio nuevo: DHL y AB Service, la tarifa de DHL; Extras Piazza, la de la categoria de su
// vehiculo. null si no se puede saber (sin categoria, Extras Stefania...): lo carga la oficina a mano.
export const precioKmAutomatico = async ({ spedizzione, categoria }) => {
  const tarifas = await getTarifasKm();
  if (DHL_AB_SPEDIZZIONI.includes(spedizzione)) return tarifas.DHL_AB;
  if (spedizzione === "EXTRA_PIAZZA" || spedizzione == null) return categoria ? (tarifas[categoria] ?? null) : null;
  return null;
};
