import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { findRecordById } from "../models/record.model.js";
import { OPEN_STATES } from "../models/compactado.model.js";
import { kmFacturables, kmMultiplier } from "../utils/kmFacturables.js";
import { AppError } from "../utils/AppError.js";
import { assertAccess, toResponse } from "./record.service.js";
import { attachFaltantes } from "./faltantes.service.js";
import { rematchAssignmentsForVehicle } from "./assignmentRematch.service.js";

// Anulacion de un servicio (solo Admin y Responsable). Si el chofer ya habia manejado antes de que se anulara, la oficina anota los
// km totales que hizo: el servicio queda "Anulado" pero esos km pasan a ser los del servicio (se facturan y se pagan, igual que en una
// reprogramacion). Sin km (0) el servicio anulado queda como siempre: sin facturacion ni pago. Tambien sirve para corregir los km de un
// servicio que ya estaba anulado.

const MAX_KM = 5000;
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

const assertOffice = (actor) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") throw new AppError("Solo Admin y Responsables pueden anotar los km de una anulacion", 403);
};

export const anularRecordForActor = async (actor, id, { kmRecorridos = 0, soloIda = false, nota = null }) => {
  assertOffice(actor);
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);

  const yaAnulado = record.estado === "ANNULLATO";
  if (!yaAnulado && !OPEN_STATES.includes(record.estado)) {
    throw new AppError("Solo se puede anular un servicio que todavia esta abierto (en suspenso, en camino o retirado)", 409);
  }

  // "Solo ida": el chofer indica los km de ida y la vuelta tambien se cuenta (x2).
  const kmIngresados = round1(Number(kmRecorridos) || 0);
  const km = round1(kmIngresados * (soloIda ? 2 : 1));
  if (km < 0 || km > MAX_KM) throw new AppError(`Los km recorridos tienen que estar entre 0 y ${MAX_KM}`, 400, { kmRecorridos: [`Entre 0 y ${MAX_KM} km`] });
  if (km > 0 && (record.servicioOrigenId || record.continuaciones?.length)) {
    throw new AppError("Este servicio tiene un traspaso entre choferes: por ahora no se pueden anotar km al anularlo", 409);
  }

  const mult = kmMultiplier(record);
  const previo = record.anulacion ?? null;
  const textoNota = typeof nota === "string" && nota.trim() ? nota.trim().slice(0, 300) : null;
  const now = new Date();

  let data;
  if (km > 0) {
    // Los km originales se guardan la primera vez para poder devolverlos si se saca el servicio de Anulado o se pone 0 km.
    const originales = record.anuladoAt ? previo?.kilometrosOriginales ?? null : record.kilometros ?? null;
    const planificados = record.anuladoAt ? previo?.kmPlanificados ?? null : kmFacturables(record);
    data = {
      estado: "ANNULLATO",
      // En DHL y AB Service el campo guarda solo la ida (se cuenta x2 al facturar).
      kilometros: round2(km / mult),
      anuladoAt: record.anuladoAt ?? now,
      anulacion: {
        kmPlanificados: planificados,
        kmHechos: km,
        kmIngresados,
        soloIda: Boolean(soloIda),
        kilometrosOriginales: originales,
        nota: textoNota,
        porId: actor.id,
        at: now.toISOString(),
      },
      ...(record.anuladoAt
        ? {}
        : { comentarios: [record.comentarios, `Anulado: el chofer hizo ${km} km antes de la anulacion${soloIda ? ` (${kmIngresados} de ida y otros tantos de vuelta)` : ""}.${textoNota ? ` ${textoNota}` : ""}`].filter(Boolean).join("\n") }),
    };
  } else {
    data = {
      estado: "ANNULLATO",
      ...(record.anuladoAt
        ? { kilometros: previo?.kilometrosOriginales ?? null, anuladoAt: null, anulacion: Prisma.DbNull }
        : {}),
      ...(textoNota && !record.anuladoAt ? { comentarios: [record.comentarios, `Anulado: ${textoNota}`].filter(Boolean).join("\n") } : {}),
    };
  }

  await prisma.record.update({ where: { id }, data, select: { id: true } });
  // Cambia si el servicio cuenta como trabajado: los peajes que le tocan se revisan en segundo plano.
  void rematchAssignmentsForVehicle(record.vehicleId);

  const full = await findRecordById(id);
  await attachFaltantes([full]);
  return toResponse(full, actor);
};
