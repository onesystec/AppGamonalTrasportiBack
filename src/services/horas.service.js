import { findRecordById, findRecordsByHorasEstado, updateRecordById } from "../models/record.model.js";
import { AppError } from "../utils/AppError.js";
import { computeShiftHours } from "../utils/workHours.js";
import { computePayIfApproved, computeServicePay } from "./finanzas.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { rematchAssignmentsForVehicle } from "./assignmentRematch.service.js";
import { assertAccess, spedizzioneFilterForActor, toJornada } from "./record.service.js";
import { computeParadasForRecord, loadParadasForRecords, refreshParadasInBackground } from "./vehicleStops.service.js";

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const MIN_MS = 60000;
const round1 = (value) => Math.round(value * 10) / 10;
const hoursText = (min) => `${round1(min / 60)} h`;

// Servicios que no se pueden cargar: anulados o reprogramados no se trabajaron.
const NOT_WORKED_STATUSES = ["ANNULLATO", "RISCHEDULATO"];

const romeStamp = (date) =>
  new Date(date).toLocaleString("es-AR", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

const notify = (record, title, body) =>
  // Best-effort: un fallo de push nunca debe romper la aprobacion.
  sendPushToUserIds([record.driverId], { title, body, data: { type: "horas", recordId: record.id } }).catch(
    () => {}
  );

// El chofer envia (o corrige) la jornada de su servicio: queda PENDIENTE hasta que el responsable
// la apruebe. Si la carga la hace la oficina, queda aprobada directamente.
export const submitHoursForActor = async (actor, id, body) => {
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);

  if (NOT_WORKED_STATUSES.includes(record.estado)) {
    throw new AppError("Un servicio anulado o reprogramado no tiene horas para cargar", 409);
  }
  const privileged = isPrivileged(actor);
  if (!privileged && record.horasEstado === "APROBADAS") {
    throw new AppError("Estas horas ya fueron aprobadas. Si hay un error, avisa al responsable", 409);
  }

  const shift = computeShiftHours(body);
  if (shift.error) throw new AppError(shift.error, 400);

  // Traspaso entre choferes: las jornadas tienen que ser coherentes con la hora en que se paso el paquete.
  if (record.servicioOrigenId) {
    if (!record.traspasoHora) {
      throw new AppError("Primero indica a que hora recibiste el paquete", 409);
    }
    if (body.inicio.getTime() > record.traspasoHora.getTime()) {
      throw new AppError(
        `Tu jornada tiene que empezar a la hora en que recibiste el paquete (${romeStamp(record.traspasoHora)}) o antes`,
        400
      );
    }
  }
  const handover = record.continuaciones?.[0]?.traspasoHora;
  if (handover && body.fin.getTime() < handover.getTime()) {
    throw new AppError(
      `Tu jornada no puede terminar antes de entregar el paquete (${romeStamp(handover)}). Termina cuando vuelves al lugar de espera`,
      400
    );
  }

  const markDelivered = body.entregado === true && !["CONSEGNATO", "RITIRATO"].includes(record.estado);
  const now = new Date();
  const data = {
    ...(markDelivered ? { estado: "CONSEGNATO" } : {}),
    horaInicioReal: body.inicio,
    horaFinReal: body.fin,
    finFueraDeBase: body.finFueraDeBase === true,
    pausaMin: shift.pausaMin,
    horasDia: shift.horasDia,
    horasNoche: shift.horasNoche,
    tiempoEspera: shift.tiempoEspera,
    horasNota: null,
    ...(body.kilometrosReales != null ? { kilometrosReales: body.kilometrosReales } : {}),
    ...(body.comentarios ? { comentarios: body.comentarios } : {}),
    ...(privileged
      ? { horasEstado: "APROBADAS", horasRevisadasAt: now, horasRevisadaPorId: actor.id }
      : { horasEstado: "PENDIENTE", horasEnviadasAt: now, horasRevisadasAt: null, horasRevisadaPorId: null }),
  };
  // Lo que el chofer envio se conserva tal cual, aunque despues la oficina lo ajuste.
  if (!privileged) {
    data.horasDeclaradas = {
      inicio: body.inicio,
      fin: body.fin,
      esperaMin: shift.esperaMin,
      pausaMin: shift.pausaMin,
      horasDia: shift.horasDia,
      horasNoche: shift.horasNoche,
    };
  }

  const updated = await updateRecordById(id, data);
  // Cambiar el estado puede cambiar a que servicio pertenece un peaje o una carga de combustible.
  if (markDelivered) await rematchAssignmentsForVehicle(record.vehicleId);
  // Las paradas del vehiculo durante la jornada se calculan aparte, sin hacer esperar al chofer.
  refreshParadasInBackground(id);
  return { jornada: toJornada(updated), pago: computePayPreview(updated) };
};

// Aprobar (tal cual o ajustando la jornada) o devolver con una nota al chofer.
export const reviewHoursForActor = async (actor, id, body) => {
  if (!isPrivileged(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);

  if (!record.horasEstado) throw new AppError("El chofer todavia no cargo horas en este servicio", 409);

  const now = new Date();

  if (body.accion === "DEVOLVER") {
    const updated = await updateRecordById(id, {
      horasEstado: "DEVUELTAS",
      horasNota: body.nota,
      horasRevisadasAt: now,
      horasRevisadaPorId: actor.id,
    });
    notify(updated, "Horas devueltas", `${updated.codigo}: ${body.nota}`);
    return { jornada: toJornada(updated), pago: computePayPreview(updated) };
  }

  const wantsAdjust = ["inicio", "fin", "esperaMin", "pausaMin"].some((key) => body[key] !== undefined);
  const data = { horasEstado: "APROBADAS", horasRevisadasAt: now, horasRevisadaPorId: actor.id };

  if (wantsAdjust) {
    if (!record.horaInicioReal || !record.horaFinReal) {
      throw new AppError("Este servicio no tiene inicio y fin cargados para ajustar", 409);
    }
    const shift = computeShiftHours({
      inicio: body.inicio ?? record.horaInicioReal,
      fin: body.fin ?? record.horaFinReal,
      esperaMin: body.esperaMin ?? Math.round((record.tiempoEspera ?? 0) * 60),
      pausaMin: body.pausaMin ?? record.pausaMin ?? 0,
    });
    if (shift.error) throw new AppError(shift.error, 400);
    // Un ajuste cambia lo que cobra el chofer: tiene que saber por que.
    if (!body.nota) throw new AppError("Explica el motivo del ajuste para que el chofer lo vea", 400);
    Object.assign(data, {
      horaInicioReal: body.inicio ?? record.horaInicioReal,
      horaFinReal: body.fin ?? record.horaFinReal,
      pausaMin: shift.pausaMin,
      horasDia: shift.horasDia,
      horasNoche: shift.horasNoche,
      tiempoEspera: shift.tiempoEspera,
    });
  }
  data.horasNota = body.nota || null;

  const updated = await updateRecordById(id, data);
  if (wantsAdjust) refreshParadasInBackground(id);
  notify(
    updated,
    wantsAdjust ? "Horas aprobadas con ajuste" : "Horas aprobadas",
    wantsAdjust ? `${updated.codigo}: ${body.nota}` : `${updated.codigo}: tus horas fueron aprobadas`
  );
  return { jornada: toJornada(updated), pago: computePayPreview(updated) };
};

const computePayPreview = (record) => {
  const actual = computeServicePay(record);
  return { actual: actual.total, siAprobada: computePayIfApproved(record).total, modo: actual.modo };
};

// Avisos para el revisor: cosas que merecen una segunda mirada antes de aprobar. No bloquean nada.
const buildWarnings = (record, totalMin) => {
  const warnings = [];
  const plannedStart = record.fechaRetiro ?? record.fechaServicio;
  if (plannedStart && record.eta) {
    const plannedMin = (new Date(record.eta).getTime() - new Date(plannedStart).getTime()) / MIN_MS;
    if (plannedMin > 0 && totalMin > plannedMin * 1.5 + 60) {
      warnings.push(`La jornada declarada (${hoursText(totalMin)}) supera bastante la planificada (${hoursText(plannedMin)})`);
    }
  }
  if (record.horaInicioReal && record.fechaRetiro) {
    const diffMin = (new Date(record.fechaRetiro).getTime() - new Date(record.horaInicioReal).getTime()) / MIN_MS;
    if (diffMin > 120) warnings.push(`El inicio declarado es ${hoursText(diffMin)} anterior a la fecha de retiro`);
  }
  const handover = record.servicioOrigenId ? record.traspasoHora : record.continuaciones?.[0]?.traspasoHora;
  if (record.servicioOrigenId) {
    const origin = record.servicioOrigen;
    if (handover && record.horaInicioReal && new Date(handover).getTime() - new Date(record.horaInicioReal).getTime() > 120 * MIN_MS) {
      warnings.push(`El inicio declarado es ${hoursText((new Date(handover) - new Date(record.horaInicioReal)) / MIN_MS)} anterior a la hora en que recibio el paquete`);
    }
    if (handover && origin?.horaFinReal && new Date(origin.horaFinReal) < new Date(handover)) {
      warnings.push(`${origin.driver ? `${origin.driver.nombre} ${origin.driver.apellido}` : "El chofer anterior"} declaro terminar su jornada antes de entregar el paquete`);
    }
  } else if (record.continuaciones?.[0] && !handover) {
    warnings.push("Traspaso sin hora de recepcion confirmada: el servicio sigue pendiente para el otro chofer");
  }
  // Lectura del GPS sobre el final de la jornada. El fin que se compara es el que declaro el chofer
  // (si la oficina lo ajusto, lo declarado queda en horasDeclaradas).
  const gps = record.gpsFin;
  const declaredEnd = new Date(record.horasDeclaradas?.fin ?? record.horaFinReal);
  const declaredStart = new Date(record.horasDeclaradas?.inicio ?? record.horaInicioReal);
  if (gps?.salidaAt && !Number.isNaN(declaredStart.getTime())) {
    const lateMin = (new Date(gps.salidaAt) - declaredStart) / MIN_MS;
    if (lateMin > 20) {
      warnings.push(`El vehiculo salio a las ${romeStamp(gps.salidaAt)}, ${hoursText(lateMin)} despues del inicio declarado (estaba parado fuera de los lugares de trabajo)`);
    }
  }
  if (gps && !Number.isNaN(declaredEnd.getTime())) {
    if (gps.ultimoMovimientoAt) {
      const movedAt = new Date(gps.ultimoMovimientoAt);
      const afterMin = (movedAt - declaredEnd) / MIN_MS;
      if (gps.continuaMoviendo) {
        warnings.push(`El vehiculo seguia circulando mas de ${hoursText(afterMin)} despues del fin declarado (${romeStamp(declaredEnd)})`);
      } else if (afterMin > 15) {
        warnings.push(`El vehiculo siguio circulando hasta las ${romeStamp(movedAt)}, ${hoursText(afterMin)} despues del fin declarado`);
      } else if (afterMin < -30) {
        warnings.push(`El vehiculo dejo de moverse a las ${romeStamp(movedAt)}, ${hoursText(-afterMin)} antes del fin declarado`);
      }
    }
    if (record.finFueraDeBase && gps.topeFinAt && declaredEnd.getTime() > new Date(gps.topeFinAt).getTime() + 15 * MIN_MS) {
      warnings.push(
        `Termino sin pasar por el lugar de espera: la regla paga hasta las ${romeStamp(gps.topeFinAt)} (lo que habria tardado en volver a ${gps.base}), declaro ${romeStamp(declaredEnd)}`
      );
    }
  }
  if (totalMin > 12 * 60) warnings.push("Jornada de mas de 12 horas");
  if (record.pausaMin === 0 && totalMin > 6 * 60) warnings.push("Mas de 6 horas sin ninguna pausa declarada");
  return warnings;
};

// Cola de aprobacion: horas enviadas por los choferes (y, si se pide, las devueltas).
export const listHoursForReviewForActor = async (actor, { estado }) => {
  if (!isPrivileged(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
  const estados = estado === "TODAS" ? ["PENDIENTE", "DEVUELTAS"] : [estado];
  const records = await findRecordsByHorasEstado({ estados, spedizzioneFilter: spedizzioneFilterForActor(actor) });
  const paradasByRecord = await loadParadasForRecords(records.map((r) => r.id));

  // Al abrir la aprobacion se calculan, en segundo plano, las paradas de las jornadas que todavia no
  // las tienen (como mucho 3 por vez, la proxima vez que se abra ya estan).
  records
    .filter((r) => r.horaInicioReal && r.horaFinReal && !r.paradasCalculadasAt)
    .slice(0, 3)
    .forEach((r) => refreshParadasInBackground(r.id));

  return records.map((record) => {
    const totalMin =
      record.horaInicioReal && record.horaFinReal
        ? (new Date(record.horaFinReal).getTime() - new Date(record.horaInicioReal).getTime()) / MIN_MS
        : null;
    return {
      id: record.id,
      codigo: record.codigo,
      destinazione: record.destinazione,
      estadoServicio: record.estado,
      cliente: record.client?.nombre ?? null,
      chofer: record.driver ? `${record.driver.nombre} ${record.driver.apellido}` : null,
      driverId: record.driverId,
      targa: record.vehicle?.targa ?? null,
      fechaServicio: record.fechaServicio,
      fechaRetiro: record.fechaRetiro,
      eta: record.eta,
      kilometros: record.kilometros,
      kilometrosReales: record.kilometrosReales,
      rutaDistanciaKm: record.rutaDistanciaKm,
      comentarios: record.comentarios,
      jornada: toJornada(record),
      totalMin,
      avisos: totalMin != null ? buildWarnings(record, totalMin) : [],
      pago: computePayPreview(record),
      traspaso: record.servicioOrigenId
        ? {
            tipo: "CONTINUACION",
            otroChofer: record.servicioOrigen?.driver
              ? `${record.servicioOrigen.driver.nombre} ${record.servicioOrigen.driver.apellido}`
              : null,
            hora: record.traspasoHora ?? null,
          }
        : record.continuaciones?.[0]
          ? {
              tipo: "ORIGEN",
              otroChofer: `${record.continuaciones[0].driver.nombre} ${record.continuaciones[0].driver.apellido}`,
              hora: record.continuaciones[0].traspasoHora ?? null,
            }
          : null,
      finFueraDeBase: record.finFueraDeBase,
      gpsFin: record.gpsFin ?? null,
      paradas: paradasByRecord.get(record.id) ?? [],
      paradasCalculadasAt: record.paradasCalculadasAt ?? null,
    };
  });
};

// Recalcula a mano las paradas de una jornada (por ejemplo si el GPS fallo al enviarla). Devuelve
// tambien la lectura del GPS sobre el fin y los avisos ya recalculados.
export const recalcParadasForActor = async (actor, id) => {
  if (!isPrivileged(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);
  await computeParadasForRecord(id);
  const [byRecord, fresh] = [await loadParadasForRecords([id]), await findRecordById(id)];
  const totalMin =
    fresh.horaInicioReal && fresh.horaFinReal
      ? (new Date(fresh.horaFinReal).getTime() - new Date(fresh.horaInicioReal).getTime()) / MIN_MS
      : null;
  return {
    paradas: byRecord.get(id) ?? [],
    paradasCalculadasAt: fresh.paradasCalculadasAt,
    gpsFin: fresh.gpsFin ?? null,
    avisos: totalMin != null ? buildWarnings(fresh, totalMin) : [],
  };
};

// El chofer que recibio un servicio de otro indica a que hora le dieron el paquete. Hasta entonces el
// servicio queda pendiente y no puede cargar sus horas. La oficina tambien puede completarla.
export const setReceptionTimeForActor = async (actor, id, body) => {
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);
  if (!record.servicioOrigenId) throw new AppError("Este servicio no fue recibido de otro chofer", 409);
  if (record.horasEstado === "APROBADAS" && !isPrivileged(actor)) {
    throw new AppError("Las horas de este servicio ya fueron aprobadas: avisa al responsable", 409);
  }

  const hora = body.hora;
  if (hora.getTime() > Date.now() + 5 * MIN_MS) {
    throw new AppError("La hora en que recibiste el paquete no puede ser futura", 400);
  }
  const origin = record.servicioOrigen;
  const originStart = new Date(origin.horaInicioReal ?? origin.fechaRetiro ?? origin.fechaServicio).getTime();
  if (hora.getTime() < originStart - 2 * 60 * MIN_MS) {
    throw new AppError("La hora no puede ser anterior al inicio del servicio original", 400);
  }
  if (record.horaInicioReal && record.horaInicioReal.getTime() > hora.getTime()) {
    throw new AppError(
      `Tu jornada ya cargada empieza a las ${romeStamp(record.horaInicioReal)}, despues de esta hora: corrige primero tus horas`,
      409
    );
  }

  const updated = await updateRecordById(id, {
    traspasoHora: hora,
    ...(record.estado === "IN_SOSPESO" ? { estado: "IN_CONSEGNA" } : {}),
  });
  return { traspasoHora: updated.traspasoHora, estado: updated.estado };
};
