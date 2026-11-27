import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { canManageFinance } from "../utils/financeAccess.js";

// Calculo por categoria (Junior, Senior, Master) de Pago a choferes: aqui solo se guardan los valores que la oficina cambio a mano por
// chofer y mes. El calculo en si (categoria por km, conduccion = km / factor x 10, etc.) lo arma la pantalla con los datos del pago.

const CAMPOS_MONTO = ["conduccion", "reperibilidad", "esperas", "disponibilidad", "productividad", "ajuste"];

const toJson = (row) => ({
  driverId: row.driverId,
  mes: row.mes,
  categoria: row.categoria,
  factor: row.factor,
  ...Object.fromEntries(CAMPOS_MONTO.map((campo) => [campo, row[campo] === null ? null : Number(row[campo])])),
  nota: row.nota,
  updatedAt: row.updatedAt,
});

export const getCategoriasPagoForActor = async (actor, { month }) => {
  if (!canManageFinance(actor)) throw new AppError("No autorizado", 403);
  if (!month) throw new AppError("Falta el mes", 400);
  const rows = await prisma.categoriaPagoChofer.findMany({ where: { mes: month } });
  return rows.map(toJson);
};

// Guarda (o borra, si todo queda en automatico) los valores manuales de un chofer en un mes.
export const setCategoriaPagoForActor = async (actor, { driverId, month, ...valores }) => {
  if (!canManageFinance(actor)) throw new AppError("No autorizado", 403);
  const driver = await prisma.user.findUnique({ where: { id: driverId }, select: { id: true } });
  if (!driver) throw new AppError("Chofer no encontrado", 404);

  const data = {
    categoria: valores.categoria ?? null,
    factor: valores.factor ?? null,
    ...Object.fromEntries(CAMPOS_MONTO.map((campo) => [campo, valores[campo] ?? null])),
    nota: valores.nota?.trim() || null,
  };
  const vacio = Object.values(data).every((v) => v === null);
  if (vacio) {
    await prisma.categoriaPagoChofer.deleteMany({ where: { driverId, mes: month } });
    return { driverId, mes: month, ...data };
  }
  const row = await prisma.categoriaPagoChofer.upsert({
    where: { driverId_mes: { driverId, mes: month } },
    create: { driverId, mes: month, ...data, cambiadoPorId: actor.id },
    update: { ...data, cambiadoPorId: actor.id },
  });
  return toJson(row);
};
