// Combustible de un servicio: hay dos fuentes y nunca se suman.
//  - Comprobantes: las cargas que el chofer (o la oficina) subio en Registro Combustible y que
//    se asignaron a este servicio. Son el dato real.
//  - Valor a mano: el campo "costo de combustible" del formulario del servicio. Es un respaldo
//    para cuando nadie subio comprobantes.
// Si hay comprobantes, mandan ellos; si no, vale lo cargado a mano.

const round2 = (value) => Math.round(value * 100) / 100;
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const effectiveFuel = ({ manual, receiptsTotal, receiptsCount }) => {
  if (receiptsCount > 0) return { fuente: "COMPROBANTES", total: round2(num(receiptsTotal)) };
  if (num(manual) > 0) return { fuente: "MANUAL", total: round2(num(manual)) };
  return { fuente: null, total: 0 };
};

// Criterio de auditoria: el valor a mano es "casi el doble o mas" de lo que suman los
// comprobantes (>= 1,8 veces) Y la diferencia es de al menos 20 EUR, para no marcar
// diferencias chicas de montos bajos. Tambien cubre el caso tipico de "subieron un comprobante
// de dos": el valor real pudo quedar a medias. No se avisa al reves (comprobantes mayores que el
// valor a mano): ahi los comprobantes ya son la evidencia.
export const FUEL_AUDIT_RATIO = 1.8;
export const FUEL_AUDIT_MIN_DIFF_EUR = 20;

export const fuelNeedsAudit = ({ manual, receiptsTotal, receiptsCount }) => {
  const m = num(manual);
  const r = num(receiptsTotal);
  return receiptsCount > 0 && r > 0 && m >= r * FUEL_AUDIT_RATIO && m - r >= FUEL_AUDIT_MIN_DIFF_EUR;
};
