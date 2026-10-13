// Cache en memoria de respuestas pesadas (un solo proceso en Render, no hace falta cache compartida).
//  - Las lecturas iguales y simultaneas comparten UNA consulta a la base (antes cada una abria la suya).
//  - El resultado se reutiliza hasta TTL, pero se descarta en cuanto se escribe en una tabla de la que
//    depende (ver el hook de config/prisma.js), asi nadie ve datos viejos despues de guardar algo.

// Cada entrada puede ser un listado de miles de servicios (varios MB): pocas, para que la cache no sea lo que llena la memoria.
const MAX_ENTRIES = 12;
// Respuestas chicas (totales, resumenes: unos KB) van aparte para que muchas combinaciones de filtros no expulsen a los listados grandes.
const MAX_SMALL_ENTRIES = 60;

let version = 0;
const entries = new Map();
const smallEntries = new Map();
const inflight = new Map();

// Se llama despues de cada escritura que cambia lo que devuelven las respuestas cacheadas.
export const bumpCacheVersion = () => {
  version += 1;
};

export const cachedResponse = async (key, ttlMs, loader, { small = false } = {}) => {
  const store = small ? smallEntries : entries;
  const max = small ? MAX_SMALL_ENTRIES : MAX_ENTRIES;
  const hit = store.get(key);
  if (hit && hit.version === version && hit.expires > Date.now()) return hit.value;

  const pending = inflight.get(key);
  if (pending && pending.version === version) return pending.promise;

  const startVersion = version;
  const promise = loader()
    .then((value) => {
      // Si hubo una escritura mientras se cargaba, el resultado puede estar viejo: no se guarda.
      if (startVersion === version) {
        store.set(key, { version: startVersion, expires: Date.now() + ttlMs, value });
        while (store.size > max) store.delete(store.keys().next().value);
      }
      return value;
    })
    .finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    });
  inflight.set(key, { version: startVersion, promise });
  return promise;
};

// Clave de una consulta de un Admin/Responsable: lo que ve depende de su cargo y de las areas que tiene (no de quien es), asi que todos
// los que ven lo mismo comparten UNA consulta. Solo para OWNER/ADMIN: las respuestas de un chofer dependen de su propio id.
export const actorQueryKey = (name, user, query) =>
  [
    name,
    user.cargo,
    [...(user.areasPermitidas ?? [])].sort().join(","),
    JSON.stringify(Object.entries(query ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  ].join("|");

const SHARED_TTL_MS = 30 * 1000;

// Para Admin y Responsables, varios piden lo mismo a la vez (abrir Finanzas o Mancato): se hace UNA lectura y todos reciben el resultado
// (hasta 30 s, o hasta que se guarde algo de lo que depende). Un chofer siempre carga lo suyo.
export const sharedForOffice = (name, user, query, loader) =>
  user.cargo === "OWNER" || user.cargo === "ADMIN"
    ? cachedResponse(actorQueryKey(name, user, query), SHARED_TTL_MS, loader, { small: true })
    : loader();
