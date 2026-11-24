import { prisma } from "../config/prisma.js";
import { SIN_ASIGNAR_CORREO, SIN_ASIGNAR_TARGA } from "../constants/sinAsignar.js";
import { AppError } from "../utils/AppError.js";

const driverSelect = { id: true, nombre: true, apellido: true };
const vehicleSelect = { targa: true, modelo: true };
const plateKey = (plate) => plate.toUpperCase().replace(/\s/g, "");

export const construirCronologia = (events) => {
  const openByDriver = new Map();
  const openByPlate = new Map();
  const periods = [];
  const close = (period, fecha) => {
    period.hasta = fecha;
    openByDriver.delete(period.driver.id);
    openByPlate.delete(plateKey(period.targa));
  };

  for (const event of [...events].sort((a, b) => a.fecha - b.fecha)) {
    const previous = openByDriver.get(event.driver.id);
    const key = event.targa ? plateKey(event.targa) : null;
    if (key && previous && plateKey(previous.targa) === key) {
      if (event.origen === "DECLARACION") previous.confirmadoEn = event.fecha;
      continue;
    }
    if (previous) close(previous, event.fecha);
    if (!key) continue;

    const previousDriver = openByPlate.get(key);
    if (previousDriver) close(previousDriver, event.fecha);
    const period = {
      driver: event.driver,
      targa: event.targa,
      modelo: event.modelo,
      desde: event.fecha,
      hasta: null,
      origen: event.origen,
      confirmadoEn: event.origen === "DECLARACION" ? event.fecha : null,
    };
    periods.push(period);
    openByDriver.set(event.driver.id, period);
    openByPlate.set(key, period);
  }
  return { periods, openByDriver, openByPlate };
};

const readEvents = async (db, now) => {
  const [records, declarations] = await Promise.all([
    db.record.findMany({
      where: {
        driver: { correoElectronico: { not: SIN_ASIGNAR_CORREO } },
        OR: [
          { horaInicioReal: { lte: now } },
          { traspasoHora: { lte: now } },
          { estado: { in: ["IN_CONSEGNA", "RITIRATO", "CONSEGNATO"] }, aceptacionChofer: null },
          { aceptacionChofer: "CONFIRMADA", estado: { in: ["IN_CONSEGNA", "RITIRATO", "CONSEGNATO"] } },
        ],
      },
      select: {
        driver: { select: driverSelect },
        vehicle: { select: vehicleSelect },
        vehiculoFinal: { select: vehicleSelect },
        horaInicioReal: true, horaFinReal: true, traspasoHora: true, fechaRetiro: true, aceptadoChoferAt: true, eta: true,
      },
    }),
    db.declaracionVehiculo.findMany({
      orderBy: [{ fecha: "asc" }, { id: "asc" }],
      select: { fecha: true, targa: true, modelo: true, driver: { select: driverSelect } },
    }),
  ]);

  const services = records.flatMap((record) => {
    const fecha = record.traspasoHora ?? record.horaInicioReal ?? record.fechaRetiro ?? record.aceptadoChoferAt ?? record.eta;
    if (fecha > now) return [];
    const events = [{ driver: record.driver, ...record.vehicle, fecha, origen: "SERVICIO" }];
    if (record.vehiculoFinal && record.horaFinReal && record.horaFinReal > fecha && record.horaFinReal <= now) {
      events.push({ driver: record.driver, ...record.vehiculoFinal, fecha: record.horaFinReal, origen: "SERVICIO" });
    }
    return events.filter((event) => event.targa !== SIN_ASIGNAR_TARGA);
  });
  const events = [...services, ...declarations.map((item) => ({ ...item, origen: "DECLARACION" }))];
  return { ...construirCronologia(events), services, declarations };
};

export const listarCronologia = async (actor) => {
  const { periods } = await readEvents(prisma, new Date());
  return periods
    .filter((period) => actor.cargo !== "CHOFER" || period.driver.id === actor.id)
    .reverse();
};

export const contextoVehiculo = async (actor) => {
  const [history, vehicles] = await Promise.all([
    readEvents(prisma, new Date()),
    prisma.vehiculo.findMany({
      where: { estado: "DISPONIBLE", targa: { not: SIN_ASIGNAR_TARGA } },
      orderBy: { targa: "asc" },
      select: { id: true, ...vehicleSelect },
    }),
  ]);
  const current = history.openByDriver.get(actor.id);
  const lastService = history.services
    .filter((event) => event.driver.id === actor.id)
    .sort((a, b) => b.fecha - a.fecha)[0];
  const latestDeclaration = history.declarations.findLast((event) => event.driver.id === actor.id);
  const candidate = current ?? lastService;
  const vehicle = candidate && vehicles.find((item) => plateKey(item.targa) === plateKey(candidate.targa));
  const holder = vehicle && history.openByPlate.get(plateKey(vehicle.targa));
  return {
    vehicles,
    lastService: lastService ? { targa: lastService.targa, fecha: lastService.fecha } : null,
    suggested: vehicle && (!holder || holder.driver.id === actor.id) &&
      (current || !latestDeclaration || latestDeclaration.fecha < lastService.fecha) ? vehicle : null,
  };
};

export const declararVehiculo = async (actor, { vehicleId, continuar }) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (db) => {
        const fecha = new Date();
        const vehicle = vehicleId && await db.vehiculo.findFirst({
          where: { id: vehicleId, estado: "DISPONIBLE", targa: { not: SIN_ASIGNAR_TARGA } },
          select: vehicleSelect,
        });
        if (vehicleId && !vehicle) throw new AppError("El vehículo ya no está disponible", 409);
        if (vehicle && continuar) {
          const { openByPlate } = await readEvents(db, fecha);
          const holder = openByPlate.get(plateKey(vehicle.targa));
          if (holder && holder.driver.id !== actor.id) {
            throw new AppError("Otro chofer ya usa esa matrícula. Selecciona tu vehículo actual.", 409);
          }
        }
        await db.declaracionVehiculo.create({
          data: { driverId: actor.id, fecha, targa: vehicle?.targa ?? null, modelo: vehicle?.modelo ?? null },
        });
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error.code !== "P2034" || attempt >= 2) throw error;
    }
  }
};
