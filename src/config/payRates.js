// Tarifas con las que se le paga a los choferes por servicio. Estan aca (y no en la base)
// porque son reglas de negocio poco frecuentes de cambiar; si cambian, todo el historial se
// recalcula con la tarifa nueva (el pago no se guarda, se calcula en cada consulta).
export const PAY_RATES = {
  // Servicio con horas cargadas (dia + noche): se paga por hora trabajada.
  horaEur: 10,
  // Servicio sin horas: se paga por distancia, proporcional (150 km = 15 EUR).
  cada100KmEur: 10,
  // Las horas de espera se suman encima, con cualquiera de las dos modalidades.
  esperaHoraEur: 10,
};

// Solo se paga lo que ya se hizo: entregado o retirado. Anulado, reprogramado, en espera o
// en curso no generan pago todavia.
export const PAYABLE_STATUSES = ["CONSEGNATO", "RITIRATO"];
