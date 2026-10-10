import { randomUUID } from "node:crypto";
import {
  OPEN_STATES,
  assignGroup,
  clearGroup,
  findCompactableRecords,
  findGroupMembers,
  findRecordsForCompact,
} from "../models/compactado.model.js";
import { VIAJES_DESDE, viajesAplican } from "../config/viajes.js";
import { AppError } from "../utils/AppError.js";
import { toServicio } from "./compactadoView.service.js";
import { spedizzioneFilterForActor, assertAccess } from "./record.service.js";

const MIN_SERVICIOS = 2;
const MAX_SERVICIOS = 8;

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";
const assertPrivileged = (actor) => {
  if (!isPrivileged(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
};

// ---------------------------------------------------------------- sugerencias

// Los ultimos servicios creados que se pueden compactar, solo de las areas del actor.
export const listCompactableForActor = async (actor) => {
  assertPrivileged(actor);
  const rows = await findCompactableRecords({ spedizzioneFilter: spedizzioneFilterForActor(actor) });
  return rows.map((r) => ({
    id: r.id,
    codigo: r.codigo,
    destinazione: r.destinazione,
    ciudad: r.ciudad,
    estado: r.estado,
    eta: r.eta,
    fechaServicio: r.fechaServicio,
    createdAt: r.createdAt,
    cliente: r.client?.nombre ?? null,
    driver: r.driver,
    vehicle: r.vehicle,
    // Servicio que este chofer recibio de otro (traspaso): se puede llevar junto con sus servicios propios.
    recibidoDe: r.servicioOrigen?.driver
      ? { codigo: r.servicioOrigen.codigo, chofer: `${r.servicioOrigen.driver.nombre} ${r.servicioOrigen.driver.apellido}` }
      : null,
  }));
};

// ---------------------------------------------------------------- crear / reordenar / deshacer

// Valida que esos servicios (en ese orden) puedan ir en un mismo viaje: mismo chofer y vehiculo, abiertos, sin
// horas cargadas, sin traspaso y dentro de las areas del actor. `groupId` = el viaje al que ya pertenecen.
const loadForCompact = async (actor, ids, groupId = null) => {
  if (new Set(ids).size !== ids.length) throw new AppError("Hay servicios repetidos", 400);
  if (ids.length < MIN_SERVICIOS) throw new AppError(`Un viaje compacto necesita al menos ${MIN_SERVICIOS} servicios`, 400);
  if (ids.length > MAX_SERVICIOS) throw new AppError(`Un viaje compacto admite como maximo ${MAX_SERVICIOS} servicios`, 400);

  const rows = await findRecordsForCompact(ids);
  if (rows.length !== ids.length) throw new AppError("Algun servicio ya no existe", 404);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id));

  for (const r of ordered) {
    assertAccess(actor, r);
    if (!viajesAplican(r.fechaServicio)) {
      throw new AppError(`${r.codigo}: los viajes compactos aplican a servicios desde el ${VIAJES_DESDE.split("-").reverse().join("/")}`, 409);
    }
    if (!OPEN_STATES.includes(r.estado)) {
      throw new AppError(`${r.codigo}: solo se pueden compactar servicios abiertos (en suspenso, en camino o retirado)`, 409);
    }
    if (r.compactadoId && r.compactadoId !== groupId) {
      throw new AppError(`${r.codigo} ya esta en otro viaje compacto`, 409);
    }
  }

  const first = ordered[0];
  const otroChofer = ordered.find((r) => r.driverId !== first.driverId);
  if (otroChofer) {
    throw new AppError(
      `Los servicios deben ser del mismo chofer: ${first.codigo} es de ${first.driver.nombre} ${first.driver.apellido} y ${otroChofer.codigo} de ${otroChofer.driver.nombre} ${otroChofer.driver.apellido}`,
      400
    );
  }
  const otroVehiculo = ordered.find((r) => r.vehicleId !== first.vehicleId);
  if (otroVehiculo) {
    throw new AppError(
      `Los servicios deben usar el mismo vehiculo: ${first.codigo} usa ${first.vehicle.targa} y ${otroVehiculo.codigo} usa ${otroVehiculo.vehicle.targa}`,
      400
    );
  }
  return ordered;
};

const groupView = async (compactadoId) => {
  const members = await findGroupMembers(compactadoId);
  if (members.length === 0) return null;
  return {
    id: compactadoId,
    total: members.length,
    principalId: members[0].id,
    servicios: members.map(toServicio),
  };
};

export const compactarForActor = async (actor, ids) => {
  assertPrivileged(actor);
  const ordered = await loadForCompact(actor, ids);
  const compactadoId = randomUUID();
  await assignGroup(compactadoId, ordered.map((r, i) => ({ id: r.id, orden: i + 1 })));
  return groupView(compactadoId);
};

// Cambia el orden de las paradas (o suma/quita servicios). Con menos de 2 el viaje se deshace. Si el servicio
// principal ya tiene horas cargadas no puede cambiar: ahi viven las horas de todo el viaje.
export const reordenarForActor = async (actor, compactadoId, ids) => {
  assertPrivileged(actor);
  const current = await findGroupMembers(compactadoId);
  if (current.length === 0) throw new AppError("Ese viaje compacto no existe", 404);
  current.forEach((m) => assertAccess(actor, m));

  const principal = current[0];
  if (principal.horasEstado && ids[0] !== principal.id) {
    throw new AppError(`Las horas del viaje ya estan cargadas en ${principal.codigo}: tiene que seguir siendo el principal`, 409);
  }
  const removed = current.filter((m) => !ids.includes(m.id));
  if (removed.some((m) => m.id === principal.id && principal.horasEstado)) {
    throw new AppError(`${principal.codigo} tiene las horas del viaje: no se puede quitar`, 409);
  }

  if (ids.length < MIN_SERVICIOS) {
    await clearGroup(current.map((m) => m.id));
    return null;
  }
  const ordered = await loadForCompact(actor, ids, compactadoId);
  await assignGroup(compactadoId, ordered.map((r, i) => ({ id: r.id, orden: i + 1 })));
  if (removed.length > 0) await clearGroup(removed.map((m) => m.id));
  return groupView(compactadoId);
};

export const descompactarForActor = async (actor, compactadoId) => {
  assertPrivileged(actor);
  const members = await findGroupMembers(compactadoId);
  if (members.length === 0) throw new AppError("Ese viaje compacto no existe", 404);
  members.forEach((m) => assertAccess(actor, m));
  if (members.some((m) => m.horasEstado)) {
    throw new AppError("El viaje ya tiene horas cargadas: no se puede deshacer", 409);
  }
  await clearGroup(members.map((m) => m.id));
};
