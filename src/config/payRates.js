// Tarifas con las que se le paga a los choferes por servicio. Estan aca (y no en la base)
// porque son reglas de negocio poco frecuentes de cambiar; si cambian, todo el historial se
// recalcula con la tarifa nueva (el pago no se guarda, se calcula en cada consulta).
export const PAY_RATES = {
  // Horas trabajadas de dia (07:00-18:59, hora de Roma) y de noche (19:00-06:59).
  horaDiaEur: 10,
  horaNocheEur: 12,
  // Servicio sin horas aprobadas: se paga por distancia, proporcional (150 km = 15 EUR).
  cada100KmEur: 10,
  // Las horas de espera se suman encima, con cualquiera de las dos modalidades.
  esperaHoraEur: 10,
};

// Banda diurna: desde DAY_START hasta antes de NIGHT_START (hora de pared de Roma).
export const DAY_BAND = { start: "07:00", end: "19:00" };

// Solo se paga lo que ya se hizo: entregado o retirado. Anulado, reprogramado, en espera o
// en curso no generan pago todavia.
export const PAYABLE_STATUSES = ["CONSEGNATO", "RITIRATO"];
