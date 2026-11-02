import { prisma } from "../config/prisma.js";

// Ancho de las columnas de las hojas del portal de clientes: se guarda por empresa cliente (todos sus usuarios ven lo mismo).
const alcanceDe = (user) => user.clienteId ?? "global";

// { dhl: { A: 120, ... }, roma: {...}, ab: {...}, extra: {...} } (solo las hojas que ya se ajustaron).
export const getHojaAnchos = async (user) => {
  const rows = await prisma.hojaAnchos.findMany({ where: { alcance: alcanceDe(user) }, select: { hoja: true, anchos: true } });
  return Object.fromEntries(rows.map((r) => [r.hoja, r.anchos]));
};

// Guarda los anchos de una hoja. Sin ninguna columna (todas vueltas al ancho automatico) se borra el registro.
export const setHojaAnchos = async (user, hoja, anchos) => {
  const alcance = alcanceDe(user);
  if (Object.keys(anchos).length === 0) {
    await prisma.hojaAnchos.deleteMany({ where: { alcance, hoja } });
    return {};
  }
  const row = await prisma.hojaAnchos.upsert({
    where: { alcance_hoja: { alcance, hoja } },
    update: { anchos, updatedById: user.id },
    create: { alcance, hoja, anchos, updatedById: user.id },
  });
  return row.anchos;
};
