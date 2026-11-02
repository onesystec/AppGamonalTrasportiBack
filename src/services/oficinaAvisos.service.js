import { prisma } from "../config/prisma.js";

// Quienes de la oficina reciben los avisos de un area (clave de constants/areas.js): el Owner y los Admin / Responsables con esa area.
export const idsDeLaOficina = async (areaKey) => {
  const users = await prisma.user.findMany({
    where: { estado: "ACTIVO", OR: [{ cargo: "OWNER" }, { cargo: "ADMIN", areasPermitidas: { has: areaKey } }] },
    select: { id: true },
  });
  return users.map((u) => u.id);
};
