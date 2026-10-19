// Reglas de la planilla de presencias que se le pasa al comercialista (descarga desde Pago a choferes).

// Horas ordinarias por dia (el contrato de cada chofer puede ser distinto, pero hoy no se guarda en el sistema): lo que pase de
// ahi va a la fila S (straordinarie).
export const HORAS_ORDINARIAS_DIA = 8;

// Codigo que lleva en la fila O un dia de permiso aprobado, segun su tipo (codigos de la leyenda del modelo).
// DESCANSO (dia libre que marca la oficina) no lleva codigo.
export const CODIGO_PERMISO = {
  VACACIONES: "F",
  ENFERMEDAD: "M",
  PERMISO: "Pnr",
  OTRO: "A",
};

export const FORMATOS_HORAS = ["decimal", "hhmm"];
