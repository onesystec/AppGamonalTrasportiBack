// Reglas para marcar en rojo un servicio al que le falta subir un peaje (mancato pagamento) o el combustible.
// Todo lo que se puede querer ajustar esta aca.

// Solo se evaluan los servicios de este mes en adelante (fecha de Roma, "AAAA-MM-DD"): el historico anterior no
// se marca. Un servicio se evalua solo cuando ya termino (entregado o retirado).
export const FALTANTES_DESDE = "2026-10-01";
export const FALTANTES_ESTADOS = ["CONSEGNATO", "RITIRATO"];

// Consumo medio por categoria de vehiculo, en litros cada 100 km (rango segun el tipo de vehiculo).
export const CATEGORIAS_VEHICULO = {
  AUTO_FURGONCINO: { label: "Auto - Furgoncino", min: 6.5, max: 7 },
  H1_L1: { label: "H1 - L1", min: 8, max: 8.5 },
  H2_L2: { label: "H2 - L2", min: 9, max: 10.5 },
  CASONATO: { label: "Casonato", min: 11, max: 14 },
};

// El servicio exige comprobante de combustible (o el switch "no fue necesario") cuando los litros estimados
// para sus km llegan a este valor. Los litros salen de km x consumo medio de la categoria del vehiculo.
// Sin categoria o sin km no se puede estimar y el combustible no se exige.
export const LITROS_MINIMOS_PARA_EXIGIR_COMBUSTIBLE = 10;
