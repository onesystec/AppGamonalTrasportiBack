import { prisma } from "../config/prisma.js";

// Historial de cambios de un servicio que ve el cliente (Piazza): lo que cambio la oficina (aqui, sin dar el nombre de nadie: "Ufficio") y lo que cambio la propia empresa
// desde el portal (ver cambioCelda.service.js, que guarda sus cambios en la misma tabla).

const FECHA = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fechaCorta = (date) => {
  const p = Object.fromEntries(FECHA.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};

const mismo = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a ?? 0).getTime() === new Date(b ?? 0).getTime() : (a ?? null) === (b ?? null));

// Se llama despues de que la oficina edita un servicio: anota los cambios que el cliente puede ver (codigos, tipo, ciudad, ETA, chofer y targa). before / after: el servicio
// antes (con chofer y vehiculo) y despues. Nunca rompe la edicion: si algo falla solo se registra el error.
export const registrarCambiosOficina = async ({ before, after, actor }) => {
  try {
    const cambios = [];
    const comparar = (campo, antes, despues, formato = (v) => String(v)) => {
      if (mismo(antes, despues)) return;
      cambios.push({ campo, anterior: antes == null ? null : formato(antes), nuevo: despues == null ? null : formato(despues) });
    };
    comparar("shipment", before.shipment, after.shipment);
    comparar("orderNumero", before.orderNumero, after.orderNumero);
    comparar("tipoPedido", before.tipoPedido, after.tipoPedido);
    comparar("ciudad", before.ciudad, after.ciudad);
    comparar("eta", before.eta, after.eta, fechaCorta);
    if (before.driverId !== after.driverId) {
      const nuevo = after.driverId ? await prisma.user.findUnique({ where: { id: after.driverId }, select: { nombre: true, apellido: true } }) : null;
      comparar("chofer", before.driver ? `${before.driver.nombre} ${before.driver.apellido}`.trim() : null, nuevo ? `${nuevo.nombre} ${nuevo.apellido}`.trim() : null);
    }
    if (before.vehicleId !== after.vehicleId) {
      const nuevo = after.vehicleId ? await prisma.vehicle.findUnique({ where: { id: after.vehicleId }, select: { targa: true } }) : null;
      comparar("targa", before.vehicle?.targa ?? null, nuevo?.targa ?? null);
    }
    if (cambios.length === 0) return;
    await prisma.cambioServicio.createMany({
      data: cambios.map((c) => ({ recordId: after.id, campo: c.campo, anterior: c.anterior, nuevo: c.nuevo, editorId: actor.id, editorNombre: "Ufficio" })),
    });
  } catch (err) {
    console.error("No se pudo anotar el cambio del servicio para el cliente:", err.message);
  }
};
