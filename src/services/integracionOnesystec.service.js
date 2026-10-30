import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";

// Lo que OneSystec lee de aqui para saber quien uso cada vehiculo y a donde llamarlo. Solo lectura, y solo lo necesario:
// nombre, celular y vehiculo del chofer, y por cada servicio el chofer, el vehiculo y la ventana de tiempo. Nada de pagos,
// documentos, ubicaciones ni de quien no maneja.
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 93;
const MAX_ROWS = 5000;
// Un servicio cancelado o reprogramado no uso el vehiculo.
const NOT_USED = ["ANNULLATO", "RISCHEDULATO"];

const plateOf = (vehicle) => vehicle?.targa?.replace(/\s+/g, "").toUpperCase() ?? null;

// Quienes manejan: los choferes y cualquiera que haya tenido un servicio (un admin que sale a manejar). El personal de oficina
// sin servicios y los clientes no salen.
export const listChoferes = async () => {
  const users = await prisma.user.findMany({
    where: { cargo: { not: "CLIENTE" }, OR: [{ cargo: "CHOFER" }, { records: { some: {} } }] },
    select: {
      id: true,
      nombre: true,
      apellido: true,
      numeroCelular: true,
      estado: true,
      vehiculoAsignado: { select: { targa: true } },
    },
    orderBy: [{ apellido: "asc" }, { nombre: "asc" }],
  });
  return users.map((u) => ({
    id: u.id,
    nombre: `${u.nombre} ${u.apellido}`.trim(),
    telefono: u.numeroCelular?.trim() || null,
    activo: u.estado === "ACTIVO",
    vehiculoHabitual: plateOf(u.vehiculoAsignado),
  }));
};

// Un servicio -> un uso del vehiculo. La ventana es la jornada que declaro el chofer (inicio y fin reales) si la hay; si no, la
// salida del vehiculo y la ETA, que es una estimacion (`declarada: false`). `hasta` queda null cuando no hay forma de saberlo.
// `placaFinal` es el furgon con el que termino cuando cambio a mitad de servicio: no se sabe a que hora cambio.
export const toUso = (record) => {
  const desde = record.horaInicioReal ?? record.fechaRetiro ?? record.fechaServicio;
  const fin = record.horaFinReal ?? record.eta ?? null;
  const hasta = fin && fin > desde ? fin : null;
  return {
    servicioId: record.id,
    choferId: record.driverId,
    placa: plateOf(record.vehicle),
    placaFinal: plateOf(record.vehiculoFinal),
    desde: desde.toISOString(),
    hasta: hasta ? hasta.toISOString() : null,
    declarada: Boolean(record.horaInicioReal && record.horaFinReal),
    estado: record.estado,
  };
};

export const listUsos = async ({ desde, hasta }) => {
  if (!(desde < hasta)) throw new AppError("El rango es invalido", 400);
  if (hasta.getTime() - desde.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new AppError(`El rango maximo es de ${MAX_RANGE_DAYS} dias`, 400);
  }
  // Un servicio de la noche anterior puede terminar dentro del rango: se mira un dia antes y se filtra por solapamiento.
  const records = await prisma.record.findMany({
    where: {
      estado: { notIn: NOT_USED },
      fechaServicio: { gte: new Date(desde.getTime() - DAY_MS), lt: hasta },
    },
    select: {
      id: true,
      driverId: true,
      estado: true,
      fechaServicio: true,
      fechaRetiro: true,
      eta: true,
      horaInicioReal: true,
      horaFinReal: true,
      vehicle: { select: { targa: true } },
      vehiculoFinal: { select: { targa: true } },
    },
    orderBy: { fechaServicio: "asc" },
    take: MAX_ROWS + 1,
  });
  if (records.length > MAX_ROWS) throw new AppError("Demasiados servicios: pide un rango mas corto", 400);

  return records.map(toUso).filter((uso) => {
    const end = uso.hasta ? new Date(uso.hasta) : new Date(new Date(uso.desde).getTime() + DAY_MS);
    return end > desde && new Date(uso.desde) < hasta;
  });
};
