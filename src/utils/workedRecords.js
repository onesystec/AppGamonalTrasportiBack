// Servicios que se trabajaron (cuentan como dia trabajado, pueden ser dueños de un peaje, tienen paradas de vehiculo...):
// todos menos los anulados y los reprogramados SIN trabajo hecho. Un servicio reprogramado con la reprogramacion de la
// oficina (reprogramadoAt) si se trabajo hasta ahi: el chofer manejo esos km y se le pagan.
export const WORKED_WHERE = {
  AND: [{ estado: { not: "ANNULLATO" } }, { OR: [{ estado: { not: "RISCHEDULATO" } }, { reprogramadoAt: { not: null } }] }],
};

// Mismo criterio para un servicio ya cargado en memoria.
export const wasWorked = (record) =>
  record.estado !== "ANNULLATO" && (record.estado !== "RISCHEDULATO" || Boolean(record.reprogramadoAt));
