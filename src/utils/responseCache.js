// Cache en memoria de respuestas pesadas (un solo proceso en Render, no hace falta cache compartida).
//  - Las lecturas iguales y simultaneas comparten UNA consulta a la base (antes cada una abria la suya).
//  - El resultado se reutiliza hasta TTL, pero se descarta en cuanto se escribe en una tabla de la que
//    depende (ver el hook de config/prisma.js), asi nadie ve datos viejos despues de guardar algo.

const MAX_ENTRIES = 60;

let version = 0;
const entries = new Map();
const inflight = new Map();

// Se llama despues de cada escritura que cambia lo que devuelven las respuestas cacheadas.
export const bumpCacheVersion = () => {
  version += 1;
};

export const cachedResponse = async (key, ttlMs, loader) => {
  const hit = entries.get(key);
  if (hit && hit.version === version && hit.expires > Date.now()) return hit.value;

  const pending = inflight.get(key);
  if (pending && pending.version === version) return pending.promise;

  const startVersion = version;
  const promise = loader()
    .then((value) => {
      // Si hubo una escritura mientras se cargaba, el resultado puede estar viejo: no se guarda.
      if (startVersion === version) {
        entries.set(key, { version: startVersion, expires: Date.now() + ttlMs, value });
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      }
      return value;
    })
    .finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    });
  inflight.set(key, { version: startVersion, promise });
  return promise;
};
