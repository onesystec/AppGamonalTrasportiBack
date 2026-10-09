import { AREA_KEYS, COMBUSTIBLE_AREA_KEY } from "../constants/areas.js";

// Quien ve que, por area de servicio:
//  - OWNER (Admin): todo.
//  - ADMIN (Responsable): solo las areas de User.areasPermitidas (que marca el Admin).
//  - CHOFER: no entra aca; ve lo suyo por driverId.
// Todas las funciones devuelven undefined cuando no hay restriccion, para poder usarlas con spread.

// null = sin restriccion.
export const actorAreaKeys = (actor) => {
  if (!actor || actor.cargo !== "ADMIN") return null;
  const keys = Array.isArray(actor.areasPermitidas) ? actor.areasPermitidas : [];
  return keys.filter((key) => AREA_KEYS.includes(key));
};

const MILANO = { OR: [{ extrasPiazzaZona: null }, { extrasPiazzaZona: "MILANO" }] };
const ROMA = { extrasPiazzaZona: "ROMA" };
const PIAZZA = { OR: [{ spedizzione: "EXTRA_PIAZZA" }, { spedizzione: null }] };

// Misma clasificacion que classifyRecord del front.
const RECORD_AREA_WHERE = {
  "dhl-milano": { AND: [{ spedizzione: "DHL" }, MILANO] },
  "dhl-roma": { AND: [{ spedizzione: "DHL" }, ROMA] },
  "ab-service": { spedizzione: "AB_SERVICE" },
  "piazza-milano": { AND: [PIAZZA, MILANO] },
  "piazza-roma": { AND: [PIAZZA, ROMA] },
  otros: { spedizzione: "EXTRAS_STEFANIA" },
};

export const recordAreaKey = (record) => {
  const roma = record.extrasPiazzaZona === "ROMA";
  if (record.spedizzione === "DHL") return roma ? "dhl-roma" : "dhl-milano";
  if (record.spedizzione === "AB_SERVICE") return "ab-service";
  if (record.spedizzione === "EXTRAS_STEFANIA") return "otros";
  return roma ? "piazza-roma" : "piazza-milano";
};

// Filtro de servicios (Record) para spread en un where. Sin areas marcadas no ve ninguno.
export const recordAreaWhere = (actor) => {
  const keys = actorAreaKeys(actor);
  if (keys === null) return undefined;
  if (keys.length === 0) return { AND: [{ id: { in: [] } }] };
  return { AND: [{ OR: keys.map((key) => RECORD_AREA_WHERE[key]) }] };
};

export const canAccessAreaKey = (actor, key) => {
  const keys = actorAreaKeys(actor);
  return keys === null || keys.includes(key);
};

// record necesita spedizzione y extrasPiazzaZona.
export const canAccessRecordArea = (actor, record) => canAccessAreaKey(actor, recordAreaKey(record));

// Combustible: guarda su propia area (enum AreaCombustible).
export const combustibleAreaWhere = (actor) => {
  const keys = actorAreaKeys(actor);
  if (keys === null) return undefined;
  const enums = Object.entries(COMBUSTIBLE_AREA_KEY)
    .filter(([, key]) => keys.includes(key))
    .map(([value]) => value);
  return { area: { in: enums } };
};

// Mancato: hereda el area del servicio al que esta asignado. Sin servicio, solo lo ven los Admin.
export const mancatoAreaWhere = (actor) => {
  const where = recordAreaWhere(actor);
  return where ? { record: { is: where } } : undefined;
};

// Multa: tiene su propia area (nullable). Sin area, solo los Admin.
export const multaAreaWhere = (actor) => {
  const keys = actorAreaKeys(actor);
  return keys === null ? undefined : { area: { in: keys } };
};
