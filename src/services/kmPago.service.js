import { prisma } from "../config/prisma.js";
import { findRecordById } from "../models/record.model.js";
import { findGroupMembers } from "../models/compactado.model.js";
import { AppError } from "../utils/AppError.js";
import { wasWorked } from "../utils/workedRecords.js";
import { assertAccess, toResponse } from "./record.service.js";
import { attachFaltantes } from "./faltantes.service.js";
import { Prisma } from "@prisma/client";

// Km a pagar al chofer fijados por la oficina (solo Admin y Responsable). Cuando lo que hizo el chofer no coincide con el circuito
// planificado (desvios, esperas en la frontera, una anulacion tardia) la oficina fija los km que se le pagan, por ejemplo los del GPS.
// En un viaje compacto el dato va en el primer servicio del viaje (el pago del viaje es uno solo). `km: null` vuelve al calculo normal.
// No cambia lo que se factura al cliente.

const MAX_KM = 10000;
const round1 = (value) => Math.round(value * 10) / 10;

const assertOffice = (actor) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") throw new AppError("Solo Admin y Responsables pueden fijar los km a pagar", 403);
};

export const fijarKmPagoForActor = async (actor, id, { km = null, nota = null }) => {
  assertOffice(actor);
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);

  const members = record.compactadoId ? await findGroupMembers(record.compactadoId) : [record];
  const holder = members[0] ?? record;
  const value = km == null ? null : round1(Number(km));
  if (value != null) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_KM) {
      throw new AppError(`Los km a pagar tienen que estar entre 0 y ${MAX_KM}`, 400, { km: [`Entre 0 y ${MAX_KM} km`] });
    }
    if (!members.some(wasWorked)) throw new AppError("Este servicio no se trabajo (anulado o reprogramado sin km): no se paga", 409);
  }
  const texto = typeof nota === "string" && nota.trim() ? nota.trim().slice(0, 300) : null;

  // Un solo lugar: el primer servicio del viaje. Si antes estaba en otro, se limpia.
  await prisma.$transaction([
    ...members.filter((m) => m.id !== holder.id).map((m) => prisma.record.update({ where: { id: m.id }, data: { kmPago: Prisma.DbNull }, select: { id: true } })),
    prisma.record.update({
      where: { id: holder.id },
      data: { kmPago: value == null ? Prisma.DbNull : { km: value, nota: texto, porId: actor.id, at: new Date().toISOString() } },
      select: { id: true },
    }),
  ]);

  const full = await findRecordById(id);
  await attachFaltantes([full]);
  return toResponse(full, actor);
};
