import { findMembersOfGroups } from "../models/compactado.model.js";
import { extraEsGrande, kmPlanificado } from "../utils/kmReparto.js";

const round1 = (value) => Math.round(value * 10) / 10;

export const toServicio = (m) => ({
  id: m.id,
  orden: m.compactadoOrden,
  codigo: m.codigo,
  destinazione: m.destinazione,
  eta: m.eta,
  estado: m.estado,
  // Km planificados y km reales (repartidos) de este servicio dentro del viaje.
  kmPlan: round1(kmPlanificado(m)),
  kmReal: m.kilometrosReales ?? null,
  // Servicio recibido de otro chofer (traspaso): "Nombre Apellido" de quien lo entrego, o null.
  recibidoDe: m.servicioOrigen?.driver ? `${m.servicioOrigen.driver.nombre} ${m.servicioOrigen.driver.apellido}` : null,
});

// Km de todo el viaje: lo planificado (suma de sus servicios), lo real (suma de lo repartido) y como se repartio.
// `real` es null mientras nadie cargo km reales.
export const kmDelViaje = (members) => {
  const planificado = round1(members.reduce((sum, m) => sum + kmPlanificado(m), 0));
  const cargados = members.filter((m) => typeof m.kilometrosReales === "number");
  const real = cargados.length > 0 ? round1(cargados.reduce((sum, m) => sum + m.kilometrosReales, 0)) : null;
  const extra = real != null ? round1(real - planificado) : null;
  return {
    planificado,
    real,
    extra,
    grande: extra != null && extra > 0 && extraEsGrande(extra, planificado),
    // Quien lo repartio y como: { origen: AUTO|CHOFER|ADMIN, servicioIds, nota, at }. null si no hay reparto guardado.
    reparto: members[0]?.kmReparto ?? null,
  };
};

// El viaje de cada servicio de la lista (compactado: { id, orden, total, principal, principalId, servicios }) o
// null. Una sola consulta para todos los viajes que aparecen. Tambien deja los miembros en
// record.compactadoMembers para que los faltantes los usen sin volver a pedirlos.
export const attachCompactados = async (records) => {
  const groupIds = [...new Set(records.map((r) => r.compactadoId).filter(Boolean))];
  const membersByGroup = new Map();
  if (groupIds.length > 0) {
    for (const m of await findMembersOfGroups(groupIds)) {
      if (!membersByGroup.has(m.compactadoId)) membersByGroup.set(m.compactadoId, []);
      membersByGroup.get(m.compactadoId).push(m);
    }
  }
  for (const record of records) {
    const members = record.compactadoId ? membersByGroup.get(record.compactadoId) : null;
    if (!members?.length) {
      record.compactado = null;
      record.compactadoMembers = null;
      continue;
    }
    const principal = members[0];
    record.compactadoMembers = members;
    record.compactado = {
      id: record.compactadoId,
      orden: record.compactadoOrden,
      total: members.length,
      principal: record.id === principal.id,
      principalId: principal.id,
      principalCodigo: principal.codigo,
      // Estado de las horas del viaje (viven en el servicio principal): PENDIENTE, APROBADAS, DEVUELTAS o null.
      principalHoras: principal.horasEstado ?? null,
      servicios: members.map(toServicio),
      km: kmDelViaje(members),
    };
  }
  return records;
};

// Miembros del viaje de cada servicio para quien solo necesita eso (faltantes), sin armar la respuesta completa.
export const loadGroupMembers = async (records) => {
  const pending = records.filter((r) => r.compactadoId && r.compactadoMembers === undefined);
  if (pending.length === 0) return records;
  await attachCompactados(pending);
  return records;
};

