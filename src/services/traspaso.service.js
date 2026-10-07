import { prisma } from "../config/prisma.js";
import { createRecord, deleteRecordById } from "../models/record.model.js";
import { AppError } from "../utils/AppError.js";
import { sendPushToUserIds } from "./pushNotification.service.js";
import { purgeFilesForRecord } from "./recordFile.service.js";

// Traspaso entre choferes: un chofer no pudo terminar un servicio y otro lo termino. El segundo
// tramo es un servicio aparte (la "continuacion") para que cada chofer tenga su propia jornada, su
// aprobacion y su pago con la logica de siempre. La continuacion no se factura (sin datos economicos)
// ni toma los peajes/combustible del original (ver servicioOrigenId en los cruces).

const personName = (p) => (p ? `${p.nombre} ${p.apellido}` : "otro chofer");

// Codigo de la continuacion: el del original + "-R" (o "-R2", ... si ya existe).
const nextContinuationCode = async (codigo) => {
  let candidate = `${codigo}-R`;
  for (let n = 2; await prisma.record.findUnique({ where: { codigo: candidate }, select: { id: true } }); n += 1) {
    candidate = `${codigo}-R${n}`;
  }
  return candidate;
};

const assertRelevoDriver = async (driverId) => {
  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { id: true, estado: true, cargo: true, nombre: true, apellido: true, vehiculoAsignadoId: true },
  });
  if (!driver || driver.estado !== "ACTIVO" || driver.cargo !== "CHOFER") {
    throw new AppError("El chofer indicado no existe, esta inactivo o no es un chofer", 400);
  }
  return driver;
};

const notifyRelevo = (record, driverId, fromName) =>
  // Best-effort: un fallo de push nunca debe romper el guardado del servicio.
  sendPushToUserIds([driverId], {
    title: "Se te asigno un servicio",
    body: `${record.codigo}: ${fromName} te paso el servicio. Indica a que hora recibiste el paquete.`,
    data: { type: "traspaso", recordId: record.id },
  }).catch(() => {});

// Crea, cambia o quita el chofer que termino el servicio. "record" es el servicio original (con
// stops y continuaciones). relevoDriverId null/undefined = nadie (quita el relevo).
export const syncRelevoForRecord = async (record, relevoDriverId) => {
  if (record.servicioOrigenId) {
    throw new AppError("Un servicio recibido de otro chofer no puede traspasarse de nuevo desde aca", 400);
  }
  const existing = record.continuaciones?.[0] ?? null;

  if (!relevoDriverId) {
    if (!existing) return;
    if (existing.horasEstado || existing.horaInicioReal) {
      throw new AppError("El chofer que termino el servicio ya cargo sus horas: no se puede quitar", 409);
    }
    await purgeFilesForRecord(existing.id);
    await deleteRecordById(existing.id);
    return;
  }

  if (relevoDriverId === record.driverId) {
    throw new AppError("El chofer que termino el servicio debe ser distinto al chofer asignado", 400);
  }
  const driver = await assertRelevoDriver(relevoDriverId);
  const fromName = personName(record.driver);

  if (existing) {
    if (existing.driverId === relevoDriverId) return;
    if (existing.horasEstado || existing.horaInicioReal) {
      throw new AppError("El chofer que termino el servicio ya cargo sus horas: no se puede cambiar", 409);
    }
    // Otro chofer: vuelve a quedar pendiente de que indique a que hora recibio el paquete.
    await prisma.record.update({
      where: { id: existing.id },
      data: { driverId: relevoDriverId, traspasoHora: null, estado: "IN_SOSPESO" },
    });
    notifyRelevo(existing, relevoDriverId, fromName);
    return;
  }

  const continuation = await createRecord({
    codigo: await nextContinuationCode(record.codigo),
    servicioOrigenId: record.id,
    driverId: relevoDriverId,
    // Normalmente viene con su propio vehiculo; si no tiene uno asignado, el mismo del servicio.
    vehicleId: driver.vehiculoAsignadoId ?? record.vehicleId,
    clientId: record.clientId,
    estado: "IN_SOSPESO",
    descripcion: record.descripcion,
    destinazione: record.destinazione,
    ciudad: record.ciudad,
    aplicativo: record.aplicativo,
    spedizzione: record.spedizzione,
    extrasPiazzaZona: record.extrasPiazzaZona,
    fechaServicio: record.fechaServicio,
    eta: record.eta,
    stops: {
      create: (record.stops ?? []).map((s) => ({
        orden: s.orden,
        direccion: s.direccion,
        lat: s.lat,
        lng: s.lng,
        geocodedAt: s.geocodedAt,
      })),
    },
  });
  notifyRelevo(continuation, relevoDriverId, fromName);
};
