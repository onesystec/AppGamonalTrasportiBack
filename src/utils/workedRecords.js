// Servicios que se trabajaron (cuentan como dia trabajado, pueden ser dueños de un peaje, tienen paradas de vehiculo...):
// todos menos los anulados y los reprogramados SIN trabajo hecho. Un servicio reprogramado con la reprogramacion de la
// oficina (reprogramadoAt) si se trabajo hasta ahi: el chofer manejo esos km y se le pagan.
// Un servicio anulado con km (anuladoAt: la oficina anoto los km que el chofer hizo antes de la anulacion) tambien se trabajo.
export const WORKED_WHERE = {
  AND: [
    { OR: [{ estado: { not: "ANNULLATO" } }, { anuladoAt: { not: null } }] },
    { OR: [{ estado: { not: "RISCHEDULATO" } }, { reprogramadoAt: { not: null } }] },
  ],
};

// Mismo criterio para un servicio ya cargado en memoria.
export const wasWorked = (record) =>
  (record.estado !== "ANNULLATO" || Boolean(record.anuladoAt)) && (record.estado !== "RISCHEDULATO" || Boolean(record.reprogramadoAt));

// Servicio que se corto antes de terminar pero el chofer ya manejo (reprogramado por la oficina o anulado con km): se paga solo
// por lo que hizo (sus km), sin el tiempo del circuito completo.
export const cortadoConKm = (record) => Boolean(record?.reprogramadoAt || record?.anuladoAt);
