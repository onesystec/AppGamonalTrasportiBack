import {
  CATEGORIAS_VEHICULO,
  FALTANTES_DESDE,
  FALTANTES_ESTADOS,
  LITROS_MINIMOS_PARA_EXIGIR_COMBUSTIBLE,
} from "../config/faltantes.js";

export const romeDay = (date) => new Date(date).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const round1 = (value) => Math.round(value * 10) / 10;

// Km del servicio: los que reporto el chofer, si no los del servicio y, de ultima, los de la ruta.
export const serviceKm = (record) => record.kilometrosReales || record.kilometros || record.rutaDistanciaKm || 0;

// El servicio se evalua solo cuando ya termino y es de la fecha de corte en adelante.
export const isEvaluable = (record) =>
  FALTANTES_ESTADOS.includes(record.estado) && romeDay(record.fechaServicio) >= FALTANTES_DESDE;

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
//
// El combustible se evalua por vehiculo y dia ("day"): se suman los litros estimados de todos los servicios
// que el vehiculo hizo ese dia, y basta UN comprobante del vehiculo ese dia, o UNA declaracion "no fue
// necesario" en cualquiera de sus servicios, para que ninguno quede pendiente. Sin "day" (contexto no
// cargado) se evalua solo el servicio.
export const computeFaltantes = (record, counts = {}, day = null) => {
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
  const ownFuel = record.combustibles ? record.combustibles.length : (counts.combustibles ?? record.fuelCount ?? 0);

  const aplica = isEvaluable(record);
  const own = estimateLiters(record);
  const dayLiters = day ? day.litros : (own?.medio ?? 0);
  const exigeCombustible = dayLiters >= LITROS_MINIMOS_PARA_EXIGIR_COMBUSTIBLE;
  const combustibleCubierto = ownFuel > 0 || (day?.comprobantes ?? 0) > 0 || Boolean(record.sinCombustible) || Boolean(day?.declarado);

  const excepcion = record.faltantesExcepcion
    ? { nota: record.faltantesExcepcionNota ?? "", por: record.faltantesExcepcionPor ?? null, at: record.faltantesExcepcionAt ?? null }
    : null;

  const exigible = aplica && !excepcion;
  const faltaIda = exigible && ida === 0 && !record.sinPeajeIda;
  const faltaVuelta = exigible && vuelta === 0 && !record.sinPeajeVuelta;
  const faltaCombustible = exigible && exigeCombustible && !combustibleCubierto;

  return {
    aplica,
    ida: faltaIda,
    vuelta: faltaVuelta,
    combustible: faltaCombustible,
    pendientes: [faltaIda, faltaVuelta, faltaCombustible].filter(Boolean).length,
    exigeCombustible,
    litrosEstimados: own,
    // Lo que se suma entre todos los servicios del vehiculo ese dia (null si no se pudo cargar).
    combustibleDia: day
      ? { litros: round1(day.litros), servicios: day.servicios, comprobantes: day.comprobantes, declarado: day.declarado }
      : null,
    excepcion,
    declarado: {
      sinPeajeIda: Boolean(record.sinPeajeIda),
      sinPeajeVuelta: Boolean(record.sinPeajeVuelta),
      sinCombustible: Boolean(record.sinCombustible),
    },
  };
};
