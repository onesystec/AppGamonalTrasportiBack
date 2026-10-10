import { kmFacturables } from "./kmFacturables.js";
import { KM_EXTRA_UMBRAL_KM, KM_EXTRA_UMBRAL_PCT, viajesAplican } from "../config/viajes.js";

const round1 = (value) => Math.round(value * 10) / 10;
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// Km planificados de un servicio dentro de un viaje compacto. En un traspaso entre choferes los km del servicio son
// los del servicio ENTERO, no los de este chofer: no cuentan.
export const kmPlanificado = (m) => {
  const traspaso = viajesAplican(m.fechaServicio) && (Boolean(m.servicioOrigenId) || (m.continuaciones?.length ?? 0) > 0);
  // Sin circuito, los km planificados (los del cliente x2 en DHL / AB Service) o los de la ruta.
  return traspaso ? 0 : kmFacturables(m) || num(m.rutaDistanciaKm);
};

// Km planificados de un viaje compacto y de cada uno de sus servicios (en el orden de `members`). Si el viaje tiene su
// circuito calculado (lugar de espera -> retiros -> paradas en orden -> lugar de espera, ver ensureCircuit), ese es el
// total y se reparte entre los servicios en proporcion a su propio recorrido; si no, vale la suma de lo que
// planificó cada uno por separado.
export const planesDelViaje = (members) => {
  const own = members.map(kmPlanificado);
  const ownTotal = own.reduce((sum, v) => sum + v, 0);
  const circuito = members[0]?.circuito?.km;
  if (!(circuito > 0)) return { total: round1(ownTotal), planes: own, circuito: false };
  const planes = ownTotal > 0 ? own.map((v) => (circuito * v) / ownTotal) : members.map(() => circuito / members.length);
  return { total: round1(circuito), planes, circuito: true };
};

// Con tantos km de mas hay que preguntarle al chofer en que servicio fueron.
export const extraEsGrande = (extra, planificado) =>
  extra > KM_EXTRA_UMBRAL_KM || (planificado > 0 && extra > planificado * KM_EXTRA_UMBRAL_PCT);

// Reparte los km reales de todo el viaje (`total`) entre sus servicios (`servicios` = [{ id, plan }]).
//  - Con km de mas y servicios indicados (`extraIds`): cada uno hace lo planificado y el extra se divide entre los
//    indicados.
//  - Si no: proporcional a lo planificado (o en partes iguales si no hay planificado).
// Los km quedan a 1 decimal y siempre suman exactamente `total`.
export const repartirKm = ({ total, servicios, extraIds = [] }) => {
  const totalKm = round1(total);
  const planificado = round1(servicios.reduce((sum, s) => sum + s.plan, 0));
  const extra = round1(totalKm - planificado);
  const elegidos = extraIds.filter((id) => servicios.some((s) => s.id === id));

  let raw;
  if (extra > 0 && elegidos.length > 0) {
    raw = servicios.map((s) => s.plan + (elegidos.includes(s.id) ? extra / elegidos.length : 0));
  } else if (planificado > 0) {
    raw = servicios.map((s) => (totalKm * s.plan) / planificado);
  } else {
    raw = servicios.map(() => totalKm / servicios.length);
  }
  const km = raw.map(round1);
  // El redondeo puede dejar unas decimas de diferencia: las absorbe el servicio con mas km.
  const diff = round1(totalKm - km.reduce((sum, v) => sum + v, 0));
  if (diff !== 0) {
    const biggest = km.indexOf(Math.max(...km));
    km[biggest] = round1(km[biggest] + diff);
  }
  return {
    total: totalKm,
    planificado,
    extra,
    servicios: servicios.map((s, i) => ({ id: s.id, km: km[i] })),
    servicioIds: extra > 0 ? elegidos : [],
  };
};

// Lo que se guarda en el servicio principal para saber como se repartio.
export const repartoMeta = (reparto, { origen, nota, por }) => ({
  origen,
  total: reparto.total,
  planificado: reparto.planificado,
  extra: reparto.extra,
  servicioIds: reparto.servicioIds,
  nota: nota || null,
  por: por ?? null,
  at: new Date().toISOString(),
});
