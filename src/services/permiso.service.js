import { findOfficeUserIdsForDriver, getOfficeScope } from "./notificationScope.service.js";
import {
  createPermiso,
  deletePermisoById,
  findApprovedPermisosInRange,
  findApprovedQuotaPermisos,
  findChoferById,
  findDriversStart,
  findWorkedRecordRange,
  findActiveChoferes,
  countPendingPermisosByDriver,
  findOverlappingPermisos,
  findPermisoById,
  findPermisos,
  findPermisosForDrivers,
  findWorkedRecordsForDrivers,
  findWorkedRecordsInRange,
  getConfig,
  setConfig,
  updatePermisoById,
} from "../models/permiso.model.js";
import { AppError } from "../utils/AppError.js";
import { kmRecorrido } from "../utils/kmFacturables.js";
import { romeLocalToDate, romeDay } from "../utils/romeTime.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Un permiso cubre como maximo un mes; hacia atras el chofer puede justificar hasta 30 dias.
const MAX_RANGO_DIAS = 31;
const MAX_RETROACTIVO_DIAS = 30;
const MAX_ANTICIPACION_DIAS = 365;

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const dayToDate = (day) => new Date(`${day}T00:00:00.000Z`);
const dateToDay = (date) => date.toISOString().slice(0, 10);
const addDays = (day, n) => dateToDay(new Date(dayToDate(day).getTime() + n * DAY_MS));
const dayDiff = (fromDay, toDay) => Math.round((dayToDate(toDay) - dayToDate(fromDay)) / DAY_MS);

const personName = (p) => (p ? `${p.nombre} ${p.apellido}` : null);

// Tope de permisos por dia: solo cuentan (y se controlan) los permisos "con cupo". La enfermedad no se
// puede planificar y el dia libre lo marca la propia oficina, asi que no entran.
const QUOTA_TIPOS = ["PERMISO", "VACACIONES", "OTRO"];
const CONFIG_KEY = "permisos.maxPorDia";
const dayLabel = (day) => `${day.slice(8)}/${day.slice(5, 7)}`;

export const getPermisosConfig = async () => {
  const row = await getConfig(CONFIG_KEY);
  const max = row?.valor?.max;
  return { maxPorDia: Number.isInteger(max) && max > 0 ? max : null };
};

export const setPermisosConfig = async (body) => {
  await setConfig(CONFIG_KEY, { max: body.maxPorDia ?? null });
  return getPermisosConfig();
};

const daysBetween = (desde, hasta) => {
  const days = [];
  for (let d = desde; d <= hasta; d = addDays(d, 1)) days.push(d);
  return days;
};

// Dia -> cuantos permisos con cupo aprobados hay (de todos los choferes) en el rango.
const loadByDay = async (desde, hasta) => {
  const rows = await findApprovedQuotaPermisos(dayToDate(desde), dayToDate(hasta), QUOTA_TIPOS);
  const load = new Map();
  for (const p of rows) {
    const from = dateToDay(p.fechaDesde) < desde ? desde : dateToDay(p.fechaDesde);
    const to = dateToDay(p.fechaHasta) > hasta ? hasta : dateToDay(p.fechaHasta);
    for (const day of daysBetween(from, to)) load.set(day, (load.get(day) ?? 0) + 1);
  }
  return load;
};

// Dias futuros (o de hoy) de un permiso donde, aprobandolo, se pasaria el tope.
const quotaConflict = (tipo, desde, hasta, load, tope, today) => {
  if (!tope || !QUOTA_TIPOS.includes(tipo)) return { diasLlenos: [], maxAprobados: 0 };
  const days = daysBetween(desde, hasta).filter((d) => d >= today);
  return {
    diasLlenos: days.filter((d) => (load.get(d) ?? 0) >= tope),
    maxAprobados: days.reduce((max, d) => Math.max(max, load.get(d) ?? 0), 0),
  };
};

const TIPO_LABEL = {
  PERMISO: "Permiso",
  ENFERMEDAD: "Enfermedad",
  VACACIONES: "Vacaciones",
  OTRO: "Otro motivo",
  DESCANSO: "Dia libre",
};

const toPermisoDto = (p, ocupacion = null) => {
  const desde = dateToDay(p.fechaDesde);
  const hasta = dateToDay(p.fechaHasta);
  return {
    id: p.id,
    driver: p.driver ? { id: p.driver.id, nombre: p.driver.nombre, apellido: p.driver.apellido } : null,
    tipo: p.tipo,
    fechaDesde: desde,
    fechaHasta: hasta,
    dias: dayDiff(desde, hasta) + 1,
    motivo: p.motivo,
    estado: p.estado,
    // Fecha y hora automaticas de la solicitud (no se pueden editar).
    solicitadoAt: p.solicitadoAt,
    // Dias entre el aviso y el primer dia del permiso: >0 avisó con anticipacion, 0 el mismo dia,
    // <0 lo justifico despues de faltar.
    anticipacionDias: dayDiff(romeDay(p.solicitadoAt), desde),
    cargadoPorOficina: p.creadoPorId !== p.driverId,
    revisadoAt: p.revisadoAt,
    revisadoPor: personName(p.revisadoPor),
    respuesta: p.respuesta,
    // Solo en solicitudes pendientes vistas por la oficina: cuantos aprobados hay ya en esos dias y
    // si aprobarla pasaria el tope.
    ocupacion,
  };
};

const notifyManagers = async (permiso, driver) => {
  try {
    const ids = await findOfficeUserIdsForDriver(permiso.driverId);
    await sendPushToUserIds(ids, {
      title: "Solicitud de permiso",
      body: `${personName(driver)} pide ${TIPO_LABEL[permiso.tipo].toLowerCase()}: ${dateToDay(permiso.fechaDesde)} a ${dateToDay(permiso.fechaHasta)}`,
      data: { type: "permiso", permisoId: permiso.id },
    });
  } catch {
    // Best-effort: un fallo de push no debe romper la solicitud.
  }
};

const notifyDriver = (permiso, title, body) =>
  sendPushToUserIds([permiso.driverId], { title, body, data: { type: "permiso", permisoId: permiso.id } }).catch(
    () => {}
  );

export const createPermisoForActor = async (actor, body) => {
  const privileged = isPrivileged(actor);
  const today = romeDay();

  let driver;
  if (privileged) {
    if (!body.driverId) throw new AppError("Elige el chofer", 400);
    driver = await findChoferById(body.driverId);
    if (!driver) throw new AppError("Chofer no encontrado", 404);
  } else {
    if (actor.cargo !== "CHOFER") throw new AppError("No autorizado", 403);
    if (body.tipo === "DESCANSO") throw new AppError("El dia libre lo marca la oficina", 403);
    driver = { id: actor.id, nombre: actor.nombre, apellido: actor.apellido };
  }

  const desde = body.fechaDesde;
  const hasta = body.fechaHasta ?? body.fechaDesde;
  if (hasta < desde) throw new AppError("La fecha final no puede ser anterior a la inicial", 400);
  if (dayDiff(desde, hasta) + 1 > MAX_RANGO_DIAS) {
    throw new AppError(`Un permiso puede cubrir como maximo ${MAX_RANGO_DIAS} dias`, 400);
  }
  if (!privileged) {
    if (dayDiff(desde, today) > MAX_RETROACTIVO_DIAS) {
      throw new AppError(`Solo puedes justificar dias de los ultimos ${MAX_RETROACTIVO_DIAS} dias`, 400);
    }
    if (dayDiff(today, desde) > MAX_ANTICIPACION_DIAS) throw new AppError("La fecha es demasiado lejana", 400);
  }

  const motivo = body.motivo?.trim() ?? "";
  if (body.tipo !== "DESCANSO" && motivo.length < 3) {
    throw new AppError("Escribe el motivo del permiso", 400);
  }

  // Tope de permisos por dia: el chofer no puede pedir un dia que ya esta completo; la oficina si
  // puede cargarlo pero se le avisa que se pasa.
  const { maxPorDia: tope } = await getPermisosConfig();
  let excedeTope = null;
  if (tope && QUOTA_TIPOS.includes(body.tipo)) {
    const conflict = quotaConflict(body.tipo, desde, hasta, await loadByDay(desde, hasta), tope, today);
    if (conflict.diasLlenos.length) {
      if (!privileged) {
        throw new AppError(
          `El ${dayLabel(conflict.diasLlenos[0])} ya no admite mas permisos (maximo ${tope} choferes ese dia). Elige otra fecha.`,
          409
        );
      }
      excedeTope = { tope, dias: conflict.diasLlenos.map(dayLabel) };
    }
  }

  const overlapping = await findOverlappingPermisos(driver.id, dayToDate(desde), dayToDate(hasta));
  if (overlapping.length) {
    throw new AppError(
      `Ya hay un permiso ${overlapping[0].estado === "PENDIENTE" ? "pendiente" : "aprobado"} que se cruza con esas fechas`,
      409
    );
  }

  const permiso = await createPermiso({
    driverId: driver.id,
    tipo: body.tipo,
    fechaDesde: dayToDate(desde),
    fechaHasta: dayToDate(hasta),
    motivo: motivo || TIPO_LABEL[body.tipo],
    creadoPorId: actor.id,
    // La oficina carga permisos ya resueltos; el chofer los pide y espera.
    ...(privileged ? { estado: "APROBADO", revisadoAt: new Date(), revisadoPorId: actor.id } : {}),
  });

  if (privileged) {
    if (driver.id !== actor.id) {
      notifyDriver(
        permiso,
        "Calendario actualizado",
        `${TIPO_LABEL[permiso.tipo]} registrado del ${desde} al ${hasta}`
      );
    }
  } else {
    await notifyManagers(permiso, driver);
  }
  return { ...toPermisoDto(permiso), excedeTope };
};

export const reviewPermisoForActor = async (actor, id, body) => {
  const permiso = await findPermisoById(id);
  if (!permiso) throw new AppError("Permiso no encontrado", 404);
  if (permiso.estado !== "PENDIENTE") throw new AppError("Este permiso ya fue resuelto", 409);

  const aprobado = body.accion === "APROBAR";
  if (aprobado && !body.forzar) {
    const { maxPorDia: tope } = await getPermisosConfig();
    const desde = dateToDay(permiso.fechaDesde);
    const hasta = dateToDay(permiso.fechaHasta);
    if (tope) {
      const conflict = quotaConflict(permiso.tipo, desde, hasta, await loadByDay(desde, hasta), tope, romeDay());
      if (conflict.diasLlenos.length) {
        throw new AppError(
          `El ${dayLabel(conflict.diasLlenos[0])} ya tiene ${tope} permisos aprobados (el tope). Aprobarlo lo supera.`,
          409,
          { codigo: "TOPE" }
        );
      }
    }
  }
  const updated = await updatePermisoById(id, {
    estado: aprobado ? "APROBADO" : "RECHAZADO",
    revisadoAt: new Date(),
    revisadoPorId: actor.id,
    respuesta: body.respuesta || null,
  });

  notifyDriver(
    updated,
    aprobado ? "Permiso aprobado" : "Permiso rechazado",
    aprobado
      ? `Tu permiso del ${dateToDay(updated.fechaDesde)} al ${dateToDay(updated.fechaHasta)} fue aprobado`
      : `Tu permiso del ${dateToDay(updated.fechaDesde)} al ${dateToDay(updated.fechaHasta)} fue rechazado: ${body.respuesta}`
  );
  return toPermisoDto(updated);
};

// El chofer solo puede cancelar lo suyo y mientras este pendiente (despues ya es un registro de
// la oficina); la oficina puede quitar cualquiera (por ejemplo una carga equivocada).
export const cancelPermisoForActor = async (actor, id) => {
  const permiso = await findPermisoById(id);
  if (!permiso) throw new AppError("Permiso no encontrado", 404);
  if (!isPrivileged(actor)) {
    if (permiso.driverId !== actor.id) throw new AppError("Permiso no encontrado", 404);
    if (permiso.estado !== "PENDIENTE") {
      throw new AppError("Solo puedes cancelar solicitudes que todavia no fueron resueltas", 409);
    }
  }
  await deletePermisoById(id);
};

export const listPermisosForActor = async (actor, { estado, driverId }) => {
  const privileged = isPrivileged(actor);
  if (!privileged && actor.cargo !== "CHOFER") throw new AppError("No autorizado", 403);
  // Un Responsable ve las solicitudes de los choferes de su asignacion (el Admin, todas).
  const scope = privileged ? await getOfficeScope(actor) : null;
  const where = {
    ...(privileged ? (driverId ? { driverId } : {}) : { driverId: actor.id }),
    ...(scope ? { driverId: driverId ? (scope.driverIds.includes(driverId) ? driverId : { in: [] }) : { in: scope.driverIds } } : {}),
    ...(estado !== "TODAS" ? { estado } : {}),
  };
  const items = await findPermisos({ where, take: 200 });
  if (!privileged) return items.map((p) => toPermisoDto(p));

  const { maxPorDia: tope } = await getPermisosConfig();
  const pending = items.filter((p) => p.estado === "PENDIENTE");
  if (!tope || !pending.length) return items.map((p) => toPermisoDto(p));

  const today = romeDay();
  const from = pending.map((p) => dateToDay(p.fechaDesde)).sort()[0];
  const to = pending.map((p) => dateToDay(p.fechaHasta)).sort().at(-1);
  const load = await loadByDay(from, to);
  return items.map((p) => {
    if (p.estado !== "PENDIENTE") return toPermisoDto(p);
    const c = quotaConflict(p.tipo, dateToDay(p.fechaDesde), dateToDay(p.fechaHasta), load, tope, today);
    return toPermisoDto(p, { tope, maxAprobados: c.maxAprobados, excede: c.diasLlenos.length > 0 });
  });
};

const monthBounds = (month) => {
  const first = `${month}-01`;
  const nextFirst = dateToDay(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)));
  return { first, nextFirst, last: addDays(nextFirst, -1) };
};

// Permisos aprobados del mes de todos los choferes, con los dias (AAAA-MM-DD) que cubre cada uno dentro del mes.
export const getApprovedPermisosForMonth = async (month) => {
  const { first, last } = monthBounds(month);
  const rows = await findApprovedPermisosInRange(dayToDate(first), dayToDate(last));
  return rows.map((p) => {
    const desde = dateToDay(p.fechaDesde) < first ? first : dateToDay(p.fechaDesde);
    const hasta = dateToDay(p.fechaHasta) > last ? last : dateToDay(p.fechaHasta);
    const dias = [];
    for (let day = desde; day <= hasta; day = addDays(day, 1)) dias.push(day);
    return { driverId: p.driverId, nombre: p.driver.nombre, apellido: p.driver.apellido, tipo: p.tipo, dias };
  });
};

const emptySummary = () => ({
  trabajados: 0,
  noTrabajados: 0,
  justificados: 0,
  descansos: 0,
  pendientes: 0,
  programados: 0,
});

// Estado de cada dia de un mes para un chofer, a partir de sus servicios y permisos (nada se guarda
// por dia). Verde: trabajo. Rojo: falto sin justificacion. Naranja: justificado y aprobado.
// Plan: 6 dias de trabajo por semana (lunes a domingo; el lunes se reinicia la cuenta) y 1 de descanso.
// Un dia laborable sin servicio es falta salvo que la oficina lo justifique o lo marque libre. El
// descanso semanal es el domingo (gris) y el sabado se trabaja: un sabado sin servicio es falta (rojo),
// salvo que el domingo si se haya trabajado (entonces el sabado es el descanso, porque ya cumplio los
// 6 dias). Si la oficina ya marco un descanso esa semana, un fin de semana libre es falta.
// "load" (opcional): cuantos permisos con cupo aprobados hay por dia, para marcar los dias completos.
const isWeekend = (day) => [0, 6].includes(dayToDate(day).getUTCDay());

// Semanas lunes-domingo que cubren el mes: el descanso se reparte por semana completa, asi que los
// servicios y permisos se consultan desde el lunes de la primera semana hasta el domingo de la ultima.
const weekMonday = (day) => addDays(day, -((dayToDate(day).getUTCDay() + 6) % 7));
const weeksWindow = (first, last) => ({
  from: weekMonday(first),
  to: addDays(weekMonday(last), 6),
  toExclusive: addDays(weekMonday(last), 7),
});

const buildDays = ({ first, last, today, startDay, servicesByDay, workedDays, permisos, load, tope }) => {
  const permisoOn = (day, estado) =>
    permisos.find((p) => p.estado === estado && dateToDay(p.fechaDesde) <= day && dateToDay(p.fechaHasta) >= day);

  const rows = [];
  const { from, to } = weeksWindow(first, last);
  for (const day of daysBetween(from, to)) {
    const servicios = servicesByDay.get(day) ?? 0;
    // Dia con trabajo: sale un servicio ese dia o uno anterior sigue en curso (viaje largo, vuelta).
    const trabajo = servicios > 0 || Boolean(workedDays?.has(day));
    const approved = permisoOn(day, "APROBADO");
    const pending = permisoOn(day, "PENDIENTE");
    const permiso = approved ?? pending ?? null;

    let estado;
    if (day < startDay) estado = "SIN_DATOS";
    else if (day > today) {
      estado =
        trabajo
          ? "PROGRAMADO"
          : approved
            ? approved.tipo === "DESCANSO"
              ? "DESCANSO"
              : "JUSTIFICADO"
            : pending
              ? "PERMISO_PENDIENTE"
              : "FUTURO";
    } else if (trabajo) estado = "TRABAJADO";
    else if (approved) estado = approved.tipo === "DESCANSO" ? "DESCANSO" : "JUSTIFICADO";
    else if (pending) estado = "PERMISO_PENDIENTE";
    else estado = day === today ? "HOY" : isWeekend(day) ? "LIBRE_FIN_DE_SEMANA" : "NO_TRABAJADO";

    rows.push({ day, servicios, trabajo, approved, permiso, estado });
  }

  for (let i = 0; i < rows.length; i += 7) {
    const week = rows.slice(i, i + 7);
    if (week.some((r) => r.estado === "DESCANSO")) {
      for (const r of week) if (r.estado === "LIBRE_FIN_DE_SEMANA") r.estado = "NO_TRABAJADO";
      continue;
    }
    // El sabado se trabaja y el domingo se descansa; el sabado solo es descanso si el domingo se trabajo.
    const [sab, dom] = [week[5], week[6]];
    if (dom.estado === "LIBRE_FIN_DE_SEMANA") dom.estado = "DESCANSO";
    if (sab.estado === "LIBRE_FIN_DE_SEMANA") sab.estado = dom.trabajo ? "DESCANSO" : "NO_TRABAJADO";
  }

  const days = [];
  const summary = emptySummary();
  for (const { day, servicios, approved, permiso, estado } of rows) {
    if (day < first || day > last) continue;
    if (estado === "TRABAJADO") summary.trabajados++;
    else if (estado === "NO_TRABAJADO") summary.noTrabajados++;
    else if (estado === "JUSTIFICADO") summary.justificados++;
    else if (estado === "DESCANSO") summary.descansos++;
    else if (estado === "PERMISO_PENDIENTE") summary.pendientes++;
    else if (estado === "PROGRAMADO") summary.programados++;

    const ocupados = load?.get(day) ?? 0;
    days.push({
      fecha: day,
      estado,
      servicios,
      permiso: permiso ? { id: permiso.id, tipo: permiso.tipo, estado: permiso.estado, motivo: permiso.motivo } : null,
      // Dia que ya no admite mas permisos (solo dias que todavia no pasaron y donde el chofer no tiene uno).
      completo: Boolean(tope) && day >= today && ocupados >= tope && !approved,
      ocupados,
    });
  }
  return { days, summary };
};

const MIN_MS = 60000;
const MAX_SERVICE_DAYS = 4;

// Dias en los que un servicio mantiene al chofer trabajando: desde que sale hasta que termina, que
// incluye la vuelta (jornada declarada, llegada del GPS, ETA o el circuito de ida y vuelta, lo que
// llegue mas tarde). Un servicio de varios dias o que termina de volver al dia siguiente cuenta todos.
const serviceDays = (r) => {
  const start = Math.min(r.fechaServicio.getTime(), (r.fechaRetiro ?? r.fechaServicio).getTime());
  const circuit =
    (r.compactadoOrden ?? 1) > 1
      ? 0
      : (r.circuitoMin > 0 ? r.circuitoMin : r.rutaDuracionMin > 0 ? r.rutaDuracionMin * 2 : 0) * MIN_MS;
  const end = Math.max(
    r.eta?.getTime() ?? 0,
    r.horaFinReal?.getTime() ?? 0,
    r.llegadaGpsAt?.getTime() ?? 0,
    circuit ? start + circuit : 0,
    start
  );
  const from = romeDay(new Date(start));
  const days = [];
  for (let day = from, i = 0; day <= romeDay(new Date(end)) && i < MAX_SERVICE_DAYS; day = addDays(day, 1), i++) days.push(day);
  return days;
};

// servicesByDay: servicios que salen cada dia (lo que se muestra); workedDays: todos los dias con trabajo.
const servicesCount = (records) => {
  const servicesByDay = new Map();
  const workedDays = new Set();
  for (const record of records) {
    const day = romeDay(record.fechaServicio);
    servicesByDay.set(day, (servicesByDay.get(day) ?? 0) + 1);
    for (const worked of serviceDays(record)) workedDays.add(worked);
  }
  return { servicesByDay, workedDays };
};

// Servicios de cada dia para la oficina (codigo, cliente, km...). Un servicio aparece en todos los dias que
// ocupa; en los que no son el de salida va marcado "enCurso" (viaje largo o vuelta).
const serviceDetailsByDay = (records) => {
  const byDay = new Map();
  for (const r of records) {
    const startDay = romeDay(r.fechaServicio);
    for (const day of serviceDays(r)) {
      const list = byDay.get(day) ?? [];
      list.push({
        id: r.id,
        codigo: r.codigo,
        estado: r.estado,
        cliente: r.client?.nombre ?? null,
        destino: r.ciudad ? `${r.destinazione ?? ""}${r.destinazione ? ", " : ""}${r.ciudad}` : (r.destinazione ?? null),
        aplicativo: r.aplicativo ?? null,
        spedizzione: r.spedizzione ?? null,
        km: Math.round(kmRecorrido(r) * 10) / 10,
        vehiculo: r.vehicle ? `${r.vehicle.targa}${r.vehicle.modelo ? ` - ${r.vehicle.modelo}` : ""}` : null,
        salida: r.fechaRetiro ?? r.fechaServicio,
        eta: r.eta,
        enCurso: day !== startDay,
      });
      byDay.set(day, list);
    }
  }
  return byDay;
};

const startDayOf = (createdAt, firstRecordDate) =>
  // Antes de que el chofer empezara (alta o primer servicio) no se marca falta.
  [romeDay(createdAt), firstRecordDate ? romeDay(firstRecordDate) : null].filter(Boolean).sort()[0];

// Calendario de un mes para un chofer.
export const getCalendarForActor = async (actor, { month, driverId }) => {
  const privileged = isPrivileged(actor);
  if (!privileged && actor.cargo !== "CHOFER") throw new AppError("No autorizado", 403);

  const targetId = privileged ? driverId : actor.id;
  if (!targetId) throw new AppError("Elige el chofer", 400);
  const driver = await findChoferById(targetId);
  if (!driver) throw new AppError("Chofer no encontrado", 404);

  const { first, last } = monthBounds(month);
  const weeks = weeksWindow(first, last);
  const today = romeDay();
  const { maxPorDia: tope } = await getPermisosConfig();

  const [records, permisos, recordRange, load] = await Promise.all([
    findWorkedRecordsInRange(driver.id, romeLocalToDate(addDays(weeks.from, -MAX_SERVICE_DAYS), "00:00"), romeLocalToDate(weeks.toExclusive, "00:00"), {
      detail: privileged,
    }),
    findPermisosInMonth(driver.id, weeks.from, weeks.to),
    findWorkedRecordRange(driver.id),
    tope ? loadByDay(first, last) : Promise.resolve(new Map()),
  ]);

  const { days, summary } = buildDays({
    first,
    last,
    today,
    startDay: startDayOf(driver.createdAt, recordRange.first),
    ...servicesCount(records),
    permisos,
    load,
    tope,
  });

  const details = privileged ? serviceDetailsByDay(records) : new Map();

  return {
    month,
    today,
    tope,
    driver: { id: driver.id, nombre: driver.nombre, apellido: driver.apellido },
    ultimoServicio: recordRange.last ? romeDay(recordRange.last) : null,
    summary,
    // El chofer solo necesita saber si un dia esta completo, no cuantos companeros faltan.
    days: privileged
      ? days.map((day) => ({ ...day, serviciosDetalle: details.get(day.fecha) ?? [] }))
      : days.map(({ ocupados, ...day }) => day),
  };
};

// Asistencia del mes de varios choferes a la vez (para el pago y las fichas). driverId -> resumen.
export const getAttendanceByDriver = async (driverIds, month) => {
  const result = new Map();
  if (!driverIds.length) return result;

  const { first, last } = monthBounds(month);
  const weeks = weeksWindow(first, last);
  const today = romeDay();
  const [records, permisos, start] = await Promise.all([
    findWorkedRecordsForDrivers(driverIds, romeLocalToDate(addDays(weeks.from, -MAX_SERVICE_DAYS), "00:00"), romeLocalToDate(weeks.toExclusive, "00:00")),
    findPermisosForDrivers(driverIds, dayToDate(weeks.from), dayToDate(weeks.to)),
    findDriversStart(driverIds),
  ]);

  const createdAt = new Map(start.users.map((u) => [u.id, u.createdAt]));
  const firstRecord = new Map(start.firsts.map((f) => [f.driverId, f._min.fechaServicio]));

  for (const id of driverIds) {
    const { summary } = buildDays({
      first,
      last,
      today,
      startDay: startDayOf(createdAt.get(id) ?? new Date(), firstRecord.get(id)),
      ...servicesCount(records.filter((r) => r.driverId === id)),
      permisos: permisos.filter((p) => p.driverId === id),
    });
    result.set(id, summary);
  }
  return result;
};

const findPermisosInMonth = (driverId, first, last) =>
  findPermisos({
    where: {
      driverId,
      estado: { in: ["PENDIENTE", "APROBADO"] },
      fechaDesde: { lte: dayToDate(last) },
      fechaHasta: { gte: dayToDate(first) },
    },
    take: 100,
  });

// Panorama de la oficina: asistencia del mes de todos los choferes activos y cuantas solicitudes
// pendientes tiene cada uno.
export const getAttendanceOverviewForActor = async (actor, { month }) => {
  if (!isPrivileged(actor)) throw new AppError("No autorizado", 403);
  const choferes = await findActiveChoferes();
  const ids = choferes.map((c) => c.id);
  const [attendance, pending] = await Promise.all([
    getAttendanceByDriver(ids, month),
    ids.length ? countPendingPermisosByDriver(ids) : Promise.resolve([]),
  ]);
  const pendingBy = new Map(pending.map((p) => [p.driverId, p._count._all]));
  return {
    month,
    items: choferes.map((c) => ({
      driver: c,
      summary: attendance.get(c.id) ?? emptySummary(),
      pendientes: pendingBy.get(c.id) ?? 0,
    })),
  };
};
