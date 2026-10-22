import { prisma } from "../config/prisma.js";
import { findRecordById } from "../models/record.model.js";
import { findVehicleById } from "../models/vehicle.model.js";
import { kmFacturables, kmMultiplier } from "../utils/kmFacturables.js";
import { distanceMeters } from "../utils/stopDetection.js";
import { AppError } from "../utils/AppError.js";
import { assertAccess, assertDriverActivo, toResponse } from "./record.service.js";
import { attachFaltantes } from "./faltantes.service.js";
import { rematchAssignmentsForVehicle } from "./assignmentRematch.service.js";
import { ensureCircuitSafe, planTiming } from "./rutaEstimada.service.js";
import { precioKmAutomatico } from "./tarifas.service.js";
import { findOnesystecVehicleIdByPlate, getVehicleDrivingStyle, isOnesystecConfigured } from "./onesystec.service.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Reprogramacion de un servicio (solo Admin y Responsable). El servicio original queda "Reprogramado" con los km que el chofer
// hizo hasta ahi (se facturan y se pagan) y se crea uno nuevo, igual al original: mismas paradas ya ubicadas en el mapa y mismo
// circuito calculado (no se vuelve a consultar Google ni el servidor de rutas), con TODOS los km del servicio, la nueva ETA y,
// si hace falta, otro chofer y/u otro vehiculo. Siempre sale del lugar de espera.

const MIN_MS = 60000;
const DAY_MS = 24 * 60 * MIN_MS;

export const MOTIVOS = ["CLIENTE_NO_ESTABA", "AVERIA", "TRAFICO_CLIMA", "ERROR_DIRECCION", "PEDIDO_CLIENTE", "OTRO"];
const MOTIVO_TEXT = {
  CLIENTE_NO_ESTABA: "el cliente no estaba",
  AVERIA: "averia",
  TRAFICO_CLIMA: "trafico o clima",
  ERROR_DIRECCION: "error de direccion",
  PEDIDO_CLIENTE: "pedido del cliente",
  OTRO: "otro motivo",
};

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const STAMP_FORMAT = new Intl.DateTimeFormat("es-AR", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const romeStamp = (date) => STAMP_FORMAT.format(new Date(date));

// Quien puede reprogramar: Admin y Responsable (nunca el chofer).
const assertOffice = (actor) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") throw new AppError("Solo Admin y Responsables pueden reprogramar un servicio", 403);
};

// Un servicio se puede reprogramar si todavia esta abierto y es un servicio comun (sin viaje compacto ni traspaso entre choferes).
const assertReprogramable = (record) => {
  if (record.estado === "RISCHEDULATO") throw new AppError("Este servicio ya esta reprogramado", 409);
  if (record.estado === "ANNULLATO") throw new AppError("Un servicio anulado no se puede reprogramar", 409);
  if (record.estado === "CONSEGNATO") throw new AppError("Un servicio entregado no se puede reprogramar", 409);
  if (record.compactadoId) throw new AppError("Este servicio va en un viaje compacto: por ahora no se puede reprogramar solo", 409);
  if (record.servicioOrigenId || record.continuaciones?.length) {
    throw new AppError("Este servicio tiene un traspaso entre choferes: por ahora no se puede reprogramar", 409);
  }
};

const loadForActor = async (actor, id) => {
  assertOffice(actor);
  const record = await findRecordById(id);
  if (!record) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, record);
  assertReprogramable(record);
  return record;
};

// Codigo del servicio nuevo: el de origen (sin sufijo previo) + "-P2", "-P3"... el primero libre.
const nextCode = async (codigo) => {
  const base = codigo.replace(/-P\d+$/, "");
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-P${n}`;
    if (!(await prisma.record.findUnique({ where: { codigo: candidate }, select: { id: true } }))) return candidate;
  }
};

// Choques del chofer y del vehiculo con otros servicios, un permiso o un trabajo adicional en la franja del servicio nuevo.
// Es un aviso: la oficina decide.
const conflictsFor = async ({ record, driverId, vehicleId, desde, hasta }) => {
  const [driverRecords, vehicleRecords, permisos, trabajos] = await Promise.all([
    prisma.record.findMany({
      where: {
        id: { not: record.id },
        driverId,
        estado: { notIn: ["ANNULLATO", "RISCHEDULATO", "CONSEGNATO"] },
        servicioOrigenId: null,
        eta: { gte: desde },
        OR: [{ fechaRetiro: { lte: hasta } }, { fechaRetiro: null, fechaServicio: { lte: hasta } }],
      },
      select: { codigo: true, eta: true },
      take: 5,
    }),
    prisma.record.findMany({
      where: {
        id: { not: record.id },
        vehicleId,
        estado: { notIn: ["ANNULLATO", "RISCHEDULATO", "CONSEGNATO"] },
        servicioOrigenId: null,
        eta: { gte: desde },
        OR: [{ fechaRetiro: { lte: hasta } }, { fechaRetiro: null, fechaServicio: { lte: hasta } }],
      },
      select: { codigo: true, eta: true },
      take: 5,
    }),
    prisma.permiso.findMany({
      where: { driverId, estado: "APROBADO", fechaDesde: { lte: hasta }, fechaHasta: { gte: desde } },
      select: { tipo: true, fechaDesde: true, fechaHasta: true },
      take: 3,
    }),
    prisma.trabajoAdicional.findMany({
      where: { driverId, estado: { not: "DEVUELTO" }, inicio: { lt: hasta }, fin: { gt: desde } },
      select: { id: true },
      take: 3,
    }),
  ]);
  const avisos = [];
  if (driverRecords.length) avisos.push(`El chofer ya tiene ${driverRecords.map((r) => `${r.codigo} (hasta ${romeStamp(r.eta)})`).join(", ")} en ese horario.`);
  if (vehicleRecords.length) avisos.push(`El vehiculo ya esta en ${vehicleRecords.map((r) => `${r.codigo} (hasta ${romeStamp(r.eta)})`).join(", ")} en ese horario.`);
  if (permisos.length) avisos.push("El chofer tiene un permiso aprobado que se cruza con esa fecha.");
  if (trabajos.length) avisos.push("El chofer tiene un trabajo adicional en esa franja.");
  return avisos;
};

// Datos para el panel del formulario, sin tocar nada: los km del servicio, la hora de salida sugerida segun la ETA (o la ETA
// segun la salida) y los avisos de choque del chofer/vehiculo elegidos. Todo sale del circuito ya calculado del servicio.
export const previewReprogramacionForActor = async (actor, id, { eta = null, salida = null, driverId = null, vehicleId = null } = {}) => {
  const record = await loadForActor(actor, id);
  const timing = eta || salida ? await planTiming(id, { eta, salida }) : null;
  const salidaAt = timing?.salidaAt ?? salida;
  const etaAt = timing?.etaAt ?? eta;
  const avisos =
    etaAt
      ? await conflictsFor({
          record,
          driverId: driverId ?? record.driverId,
          vehicleId: vehicleId ?? record.vehicleId,
          desde: new Date(salidaAt ?? etaAt),
          hasta: new Date(timing?.finEstimadoAt ?? etaAt),
        })
      : [];
  return {
    kmPlanificados: kmFacturables(record),
    multiplicadorKm: kmMultiplier(record),
    timing,
    avisos,
  };
};

// Km que hizo el vehiculo desde que salio: el GPS del vehiculo (OneSystec) y, si no se puede, la suma de las posiciones del
// celular del chofer. Es solo una sugerencia para el campo de km hechos.
const PHONE_ROAD_FACTOR = 1.2; // las posiciones del celular van en linea recta entre pings: se compensa un poco
export const gpsKmForRecordForActor = async (actor, id) => {
  const record = await loadForActor(actor, id);
  const from = (record.fechaRetiro ?? record.fechaServicio).getTime();
  const to = Date.now();
  if (to <= from) return { km: null, fuente: null };

  if (isOnesystecConfigured() && record.vehicle?.targa) {
    try {
      const onesystecId = await findOnesystecVehicleIdByPlate(record.vehicle.targa);
      if (onesystecId) {
        const style = await getVehicleDrivingStyle(onesystecId, from, Math.min(to, from + 31 * DAY_MS));
        if (typeof style?.distanceKm === "number" && style.distanceKm > 0) return { km: round1(style.distanceKm), fuente: "VEHICULO" };
      }
    } catch (err) {
      console.error("[reprogramacion] no se pudieron leer los km del GPS del vehiculo:", err.message);
    }
  }
  const pings = await prisma.locationPing.findMany({
    where: { driverId: record.driverId, recordedAt: { gte: new Date(from), lte: new Date(to) } },
    orderBy: { recordedAt: "asc" },
    select: { lat: true, lng: true },
  });
  if (pings.length >= 2) {
    let meters = 0;
    for (let i = 1; i < pings.length; i += 1) meters += distanceMeters(pings[i - 1], pings[i]);
    const km = (meters / 1000) * PHONE_ROAD_FACTOR;
    if (km > 0.5) return { km: round1(km), fuente: "CELULAR" };
  }
  return { km: null, fuente: null };
};

const notify = (userIds, title, body, recordId) =>
  // Best-effort: un fallo de push nunca debe romper la reprogramacion.
  sendPushToUserIds(userIds, { title, body, data: { type: "reprogramacion", recordId } }).catch(() => {});

export const reprogramarRecordForActor = async (actor, id, body) => {
  const record = await loadForActor(actor, id);
  const kmPlanificados = kmFacturables(record);
  const mult = kmMultiplier(record);

  const kmHechos = round1(body.kmHechos);
  if (kmPlanificados > 0 && kmHechos > kmPlanificados) {
    throw new AppError(`Los km hechos (${kmHechos}) no pueden superar los del servicio (${kmPlanificados})`, 400, {
      kmHechos: [`Maximo ${kmPlanificados} km`],
    });
  }
  if (body.fechaRetiro && body.fechaRetiro.getTime() >= body.eta.getTime()) {
    throw new AppError("La salida tiene que ser antes de la ETA", 400, { fechaRetiro: ["Tiene que ser antes de la ETA"] });
  }

  const cambioChofer = Boolean(body.cambioChofer);
  const cambioVehiculo = Boolean(body.cambioVehiculo);
  if (cambioChofer && !body.nuevoChoferId) throw new AppError("Elige el chofer nuevo", 400, { nuevoChoferId: ["Obligatorio"] });
  if (cambioVehiculo && !body.nuevoVehiculoId) throw new AppError("Elige el vehiculo nuevo", 400, { nuevoVehiculoId: ["Obligatorio"] });
  const nuevoChoferId = cambioChofer ? body.nuevoChoferId : record.driverId;
  const nuevoVehiculoId = cambioVehiculo ? body.nuevoVehiculoId : record.vehicleId;
  if (cambioChofer && nuevoChoferId === record.driverId) {
    throw new AppError("El chofer nuevo es el mismo del servicio: desmarca el cambio de chofer", 400, { nuevoChoferId: ["Es el mismo chofer"] });
  }
  if (cambioVehiculo && nuevoVehiculoId === record.vehicleId) {
    throw new AppError("El vehiculo nuevo es el mismo del servicio: desmarca el cambio de vehiculo", 400, { nuevoVehiculoId: ["Es el mismo vehiculo"] });
  }
  if (cambioChofer) await assertDriverActivo(nuevoChoferId);
  const nuevoVehiculo = cambioVehiculo ? await findVehicleById(nuevoVehiculoId) : record.vehicle;
  if (!nuevoVehiculo) throw new AppError("El vehiculo indicado no existe", 400, { nuevoVehiculoId: ["No existe"] });

  // Precio por km: el del servicio; si era el automatico de la categoria del vehiculo y el vehiculo cambia, el del vehiculo nuevo.
  let precioKm = record.precioKm;
  if (cambioVehiculo) {
    const previo = await precioKmAutomatico({ spedizzione: record.spedizzione, categoria: record.vehicle?.categoria });
    if (record.precioKm == null || record.precioKm === previo) {
      const nuevo = await precioKmAutomatico({ spedizzione: record.spedizzione, categoria: nuevoVehiculo.categoria });
      if (nuevo != null) precioKm = nuevo;
    }
  }

  const codigo = await nextCode(record.codigo);
  const fechaRetiro = body.fechaRetiro ?? null;
  const now = new Date();
  const motivoTexto = body.motivo ? MOTIVO_TEXT[body.motivo] : null;

  // Todo junto: o se reprograma completo o no se toca nada.
  const [nuevo, original] = await prisma.$transaction(async (tx) => {
    const created = await tx.record.create({
      data: {
        estado: "IN_SOSPESO",
        driverId: nuevoChoferId,
        vehicleId: nuevoVehiculoId,
        clientId: record.clientId,
        fechaServicio: fechaRetiro ?? body.eta,
        eta: body.eta,
        fechaRetiro,
        descripcion: record.descripcion,
        codigo,
        destinazione: record.destinazione,
        ciudad: record.ciudad,
        aplicativo: record.aplicativo,
        spedizzione: record.spedizzione,
        extrasPiazzaZona: record.extrasPiazzaZona,
        pasaPorBrennero: record.pasaPorBrennero,
        pasaPorFrejus: record.pasaPorFrejus,
        // Siempre sale del lugar de espera: la salida y la ruta son las del servicio original (ya calculadas).
        salidaDireccion: record.salidaDireccion,
        salidaLat: record.salidaLat,
        salidaLng: record.salidaLng,
        rutaDistanciaKm: record.rutaDistanciaKm,
        rutaDuracionMin: record.rutaDuracionMin,
        rutaGeometria: record.rutaGeometria ?? undefined,
        rutaCalculadaAt: record.rutaCalculadaAt,
        circuito: record.circuito ? { ...record.circuito, servicios: [codigo] } : undefined,
        // Los km del servicio completo y el precio: el servicio nuevo se factura entero.
        kilometros: record.kilometros,
        precioKm,
        comentarios: `Reprogramacion de ${record.codigo}${motivoTexto ? ` (${motivoTexto})` : ""}.`,
        reprogramadoDeId: record.id,
        // Las mismas paradas, con las coordenadas que ya tienen: no se vuelven a buscar en el mapa.
        stops: {
          create: record.stops.map((s) => ({ orden: s.orden, direccion: s.direccion, lat: s.lat, lng: s.lng, geocodedAt: s.geocodedAt })),
        },
      },
    });
    const updated = await tx.record.update({
      where: { id: record.id },
      data: {
        estado: "RISCHEDULATO",
        // Los km que hizo el chofer: en DHL y AB Service el campo guarda solo la ida (se cuenta x2 al facturar).
        kilometros: round2(kmHechos / mult),
        reprogramadoAt: now,
        reprogramacion: {
          kmPlanificados,
          kmHechos,
          motivo: body.motivo ?? null,
          nuevoId: created.id,
          nuevoCodigo: codigo,
          nuevaEta: body.eta.toISOString(),
          nuevaSalida: fechaRetiro ? fechaRetiro.toISOString() : null,
          cambioChofer,
          cambioVehiculo,
          nuevoChoferId,
          nuevoVehiculoId,
          porId: actor.id,
        },
        comentarios: [record.comentarios, `Reprogramado como ${codigo}${motivoTexto ? ` (${motivoTexto})` : ""}: el chofer hizo ${kmHechos} km.`]
          .filter(Boolean)
          .join("\n"),
      },
    });
    return [created, updated];
  });

  // Sin circuito para copiar (el servicio todavia no lo tenia): se calcula en segundo plano con las paradas ya ubicadas.
  if (!nuevo.circuito) void ensureCircuitSafe(nuevo.id);
  void rematchAssignmentsForVehicle(record.vehicleId);
  if (nuevoVehiculoId !== record.vehicleId) void rematchAssignmentsForVehicle(nuevoVehiculoId);

  const when = romeStamp(body.eta);
  if (cambioChofer) {
    notify([nuevoChoferId], "Se te asigno un servicio", `${codigo}: reprogramado para ${when}.`, nuevo.id);
    notify([record.driverId], "Servicio reprogramado", `${record.codigo} se reprogramo y lo hara otro chofer.`, record.id);
  } else {
    notify([nuevoChoferId], "Servicio reprogramado", `${record.codigo} se reprogramo: ${codigo}, ETA ${when}.`, nuevo.id);
  }

  const [full, fullOriginal] = await Promise.all([findRecordById(nuevo.id), findRecordById(original.id)]);
  await attachFaltantes([full, fullOriginal]);
  return { original: toResponse(fullOriginal, actor), nuevo: toResponse(full, actor) };
};

// Deshace una reprogramacion cuando el servicio nuevo todavia no se toco (sigue en espera, sin horas, archivos ni peajes):
// borra la copia y devuelve el original a su estado y sus km. Solo Admin/Responsable.
export const deshacerReprogramacionForActor = async (actor, id) => {
  assertOffice(actor);
  const original = await findRecordById(id);
  if (!original) throw new AppError("Registro no encontrado", 404);
  assertAccess(actor, original);
  const info = original.reprogramacion;
  if (original.estado !== "RISCHEDULATO" || !original.reprogramadoAt || !info?.nuevoId) {
    throw new AppError("Este servicio no fue reprogramado desde el sistema", 409);
  }
  const nuevo = await prisma.record.findUnique({
    where: { id: info.nuevoId },
    select: { id: true, estado: true, horasEstado: true, horaInicioReal: true, _count: { select: { files: true, mancatos: true, combustibles: true, continuaciones: true } } },
  });
  if (nuevo) {
    const tocado =
      nuevo.estado !== "IN_SOSPESO" || nuevo.horasEstado || nuevo.horaInicioReal || Object.values(nuevo._count).some((n) => n > 0);
    if (tocado) throw new AppError("El servicio nuevo ya tiene movimiento (estado, horas, archivos o peajes): no se puede deshacer", 409);
  }
  await prisma.$transaction(async (tx) => {
    if (nuevo) await tx.record.delete({ where: { id: nuevo.id } });
    await tx.record.update({
      where: { id: original.id },
      data: {
        estado: "IN_SOSPESO",
        kilometros: info.kmPlanificados != null ? round2(info.kmPlanificados / kmMultiplier(original)) : original.kilometros,
        reprogramadoAt: null,
        reprogramacion: null,
        comentarios:
          (original.comentarios ?? "")
            .split("\n")
            .filter((line) => !line.startsWith("Reprogramado como "))
            .join("\n") || null,
      },
    });
  });
  void rematchAssignmentsForVehicle(original.vehicleId);
  const fresh = await findRecordById(id);
  await attachFaltantes([fresh]);
  return toResponse(fresh, actor);
};
