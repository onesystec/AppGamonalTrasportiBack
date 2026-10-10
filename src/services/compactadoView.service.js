import { findMembersOfGroups } from "../models/compactado.model.js";

export const toServicio = (m) => ({
  id: m.id,
  orden: m.compactadoOrden,
  codigo: m.codigo,
  destinazione: m.destinazione,
  eta: m.eta,
  estado: m.estado,
  // Servicio recibido de otro chofer (traspaso): "Nombre Apellido" de quien lo entrego, o null.
  recibidoDe: m.servicioOrigen?.driver ? `${m.servicioOrigen.driver.nombre} ${m.servicioOrigen.driver.apellido}` : null,
});

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
      servicios: members.map(toServicio),
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

