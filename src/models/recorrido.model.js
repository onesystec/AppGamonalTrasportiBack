import { prisma } from "../config/prisma.js";

export const findRecorrido = (recordId) => prisma.recorridoReal.findUnique({ where: { recordId } });

// Guarda el recorrido comparado y la marca ("OK" / "REVISAR" / "SIN_DATOS") del servicio.
export const saveRecorrido = async (recordId, { estado, resumen, geometria }) => {
  const data = { resumen, geometria: geometria ?? null, calculadoAt: new Date() };
  await prisma.recorridoReal.upsert({ where: { recordId }, create: { recordId, ...data }, update: data });
  await prisma.record.update({ where: { id: recordId }, data: { recorridoEstado: estado }, select: { id: true } });
};
