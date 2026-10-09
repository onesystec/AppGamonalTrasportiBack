import { PrismaClient } from "@prisma/client";
import { bumpCacheVersion } from "../utils/responseCache.js";
import { env } from "./env.js";

const base = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

// Tablas de las que dependen las respuestas cacheadas (listado de servicios con su combustible). Los
// nombres de chofer/vehiculo/cliente tambien salen en ese listado, pero cambian poco (y esas tablas
// se escriben seguido por la ubicacion y el GPS), asi que quedan cubiertas solo por el TTL.
const CACHE_MODELS = new Set(["Record", "RegistroCombustible"]);
const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

export const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (CACHE_MODELS.has(model) && WRITE_OPERATIONS.has(operation)) bumpCacheVersion();
        return result;
      },
    },
  },
});
