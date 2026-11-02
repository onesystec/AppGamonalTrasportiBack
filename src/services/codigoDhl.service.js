import { prisma } from "../config/prisma.js";

// El codigo de un servicio DHL es su Shipment (uno solo por servicio, como los Extras Piazza tienen su codigo). Los que la app generaba solos
// ("DHL-1793263170123") se reemplazan por el Shipment; un codigo escrito a mano o con sufijo de reprogramacion ("...-P2") no se toca.
const AUTOMATICO = /^(DHL|AB_SERVICE)-\d{10,}$/;

// Devuelve el codigo nuevo o null si no hay nada que cambiar. codigoActual / shipmentActual / id: el servicio que ya existe (al editar).
// Si otro servicio ya usa ese Shipment como codigo (mismo pedido cargado dos veces), se deja el codigo que tenia.
export const codigoDesdeShipment = async ({ spedizzione, shipment, codigoActual = null, shipmentActual = null, id = null }) => {
  const nuevo = typeof shipment === "string" ? shipment.trim() : "";
  if (spedizzione !== "DHL" || !nuevo || codigoActual === nuevo) return null;
  const sigueElShipment = codigoActual == null || AUTOMATICO.test(codigoActual) || (shipmentActual != null && codigoActual === shipmentActual);
  if (!sigueElShipment) return null;
  const ocupado = await prisma.record.findUnique({ where: { codigo: nuevo }, select: { id: true } });
  return ocupado && ocupado.id !== id ? null : nuevo;
};
