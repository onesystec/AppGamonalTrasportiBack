import {
  CATEGORIAS_VEHICULO,
  FALTANTES_DESDE,
  FALTANTES_ESTADOS,
  LITROS_MINIMOS_PARA_EXIGIR_COMBUSTIBLE,
} from "../config/faltantes.js";

const romeDay = (date) => new Date(date).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const round1 = (value) => Math.round(value * 10) / 10;

// Km del servicio: los que reporto el chofer, si no los del servicio y, de ultima, los de la ruta.
const serviceKm = (record) => record.kilometrosReales || record.kilometros || record.rutaDistanciaKm || 0;

// Litros estimados para los km del servicio (rango minimo-maximo y medio) segun la categoria del vehiculo.
export const estimateLiters = (record) => {
  const category = CATEGORIAS_VEHICULO[record.vehicle?.categoria];
  const km = serviceKm(record);
  if (!category || !km) return null;
  const min = (km * category.min) / 100;
  const max = (km * category.max) / 100;
  return { km: round1(km), min: round1(min), max: round1(max), medio: round1((min + max) / 2) };
};

// Un servicio sin peaje de un tramo / sin combustible esta "pendiente" hasta que haya un registro asignado
// o el chofer declare que no corresponde. "counts" trae los registros asignados cuando el servicio viene de
// un listado (sin las listas completas): { mancatoIda, mancatoVuelta, mancatoSinTramo, combustibles }.
export const computeFaltantes = (record, counts = {}) => {
  const mancatos = record.mancatos;
  let ida = mancatos ? mancatos.filter((m) => m.tramo === "IDA").length : (counts.mancatoIda ?? 0);
  let vuelta = mancatos ? mancatos.filter((m) => m.tramo === "VUELTA").length : (counts.mancatoVuelta ?? 0);
  let sinTramo = mancatos ? mancatos.filter((m) => !m.tramo).length : (counts.mancatoSinTramo ?? 0);
  // Un peaje asignado a mano sin tramo cubre el primer tramo que todavia falte.
  while (sinTramo > 0 && (ida === 0 || vuelta === 0)) {
    if (ida === 0) ida += 1;
    else vuelta += 1;
    sinTramo -= 1;
  }
  const fuelCount = record.combustibles ? record.combustibles.length : (counts.combustibles ?? record.fuelCount ?? 0);

  const aplica = FALTANTES_ESTADOS.includes(record.estado) && romeDay(record.fechaServicio) >= FALTANTES_DESDE;
  const litros = estimateLiters(record);
  const exigeCombustible = Boolean(litros && litros.medio >= LITROS_MINIMOS_PARA_EXIGIR_COMBUSTIBLE);

  const faltaIda = aplica && ida === 0 && !record.sinPeajeIda;
  const faltaVuelta = aplica && vuelta === 0 && !record.sinPeajeVuelta;
  const faltaCombustible = aplica && exigeCombustible && fuelCount === 0 && !record.sinCombustible;

  return {
    aplica,
    ida: faltaIda,
    vuelta: faltaVuelta,
    combustible: faltaCombustible,
    pendientes: [faltaIda, faltaVuelta, faltaCombustible].filter(Boolean).length,
    // Datos para mostrar por que se exige (o no) el combustible.
    exigeCombustible,
    litrosEstimados: litros,
    declarado: {
      sinPeajeIda: Boolean(record.sinPeajeIda),
      sinPeajeVuelta: Boolean(record.sinPeajeVuelta),
      sinCombustible: Boolean(record.sinCombustible),
    },
  };
};
