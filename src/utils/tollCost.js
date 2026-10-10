// Peajes de un servicio: hay dos fuentes y nunca se suman (igual que el combustible, ver utils/fuelCost.js).
//  - Mancatos: los avisos de mancato pagamento que se asignaron a este servicio (por fecha y hora del transito).
//    Son el dato real.
//  - Valor a mano: el campo "Peajes" del formulario del servicio, para cuando no hay ningun mancato asignado.
// Si hay mancatos asignados, mandan ellos; si no, vale lo cargado a mano.

const round2 = (value) => Math.round(value * 100) / 100;
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const effectiveTolls = ({ manual, mancatosTotal, mancatosCount }) => {
  if (mancatosCount > 0) return { fuente: "MANCATOS", total: round2(num(mancatosTotal)) };
  if (num(manual) > 0) return { fuente: "MANUAL", total: round2(num(manual)) };
  return { fuente: null, total: 0 };
};

// Para registros que traen la lista `mancatos: [{ costo }]` (finanzas): el mismo registro con `peajes` efectivo.
export const withEffectiveTolls = ({ mancatos, ...record }) => ({
  ...record,
  peajes: effectiveTolls({
    manual: record.peajes,
    mancatosTotal: (mancatos ?? []).reduce((sum, m) => sum + Number(m.costo), 0),
    mancatosCount: mancatos?.length ?? 0,
  }).total,
});
