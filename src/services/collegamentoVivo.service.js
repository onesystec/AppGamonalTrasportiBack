import { prisma } from "../config/prisma.js";
import { SIN_ASIGNAR_NOMBRE, SIN_ASIGNAR_TARGA } from "../constants/sinAsignar.js";
import { AppError } from "../utils/AppError.js";
import { allSeguimiento } from "./cliente.service.js";
import { filtrarParaOficina } from "./seguimiento.service.js";

// "Servicios en curso" que Gamonal comparte con una app conectada (App Piazza) cuando ELLA los pide (POST /collegamenti/pubblico/:id/vivo). Solo lectura: Gamonal no empuja nada.
// Usa la misma lectura (y cache de 25 s) que el seguimiento de Gamonal, asi no se recalcula nada pesado en cada llamada. Solo se comparte si el Owner activo el
// interruptor de ESA conexion, y solo salen los campos de abajo: nada de importes, documentos, telefonos ni datos personales del chofer.

export const MAX_SERVIZI_VIVO = 300;
const ESTADI_VIVO = new Set(["RITIRATO", "IN_CONSEGNA"]);

const iso = (v) => (v ? new Date(v).toISOString() : null);

// Posicion real del vehiculo (nunca la simulada) con su hora; sin hora no se manda (no se inventa).
const gpsDi = (gps) =>
  gps && gps.fuente !== "SIMULADO" && gps.lat != null && gps.lng != null && gps.actualizada
    ? { lat: gps.lat, lng: gps.lng, ...(gps.rumbo != null ? { rumbo: gps.rumbo } : {}), actualizada: gps.actualizada }
    : null;

export const serviziInCorso = async (riga) => {
  if (riga.stato !== "ATTIVO" || riga.ruolo !== "CLIENTE") throw new AppError("Il collegamento non è attivo", 409);
  if (!riga.condividiServiziInCorso) throw new AppError("Questo collegamento non condivide i servizi in corso", 403);

  const { servicios } = await allSeguimiento();
  // Los vehiculos que el Owner oculta del mapa tampoco se comparten.
  const { visibles } = await filtrarParaOficina(servicios.filter((s) => ESTADI_VIVO.has(s.estado)));
  // Por hora prevista de llegada (el seguimiento ya viene asi; se asegura aqui) y como mucho 300.
  const lista = [...visibles].sort((a, b) => new Date(a.etaPlan) - new Date(b.etaPlan)).slice(0, MAX_SERVIZI_VIVO);

  // De los que llegaron por ESTA conexion: el id del servicio en la otra app (y su ritiro). Los de otras conexiones no se marcan.
  const origen = lista.length
    ? await prisma.solicitudServicio.findMany({
        where: { recordId: { in: lista.map((s) => s.id) }, collegamentoId: riga.id, recordRemotoId: { not: null } },
        select: { recordId: true, recordRemotoId: true, ritiro: true },
      })
    : [];
  const porRecord = new Map(origen.map((o) => [o.recordId, o]));

  return {
    servizi: lista.map((s) => {
      const da = porRecord.get(s.id);
      const autista = s.chofer?.nombre && s.chofer.nombre !== SIN_ASIGNAR_NOMBRE ? s.chofer.nombre : null;
      const targa = s.vehiculo && s.vehiculo !== SIN_ASIGNAR_TARGA ? s.vehiculo : null;
      const gps = gpsDi(s.gps);
      return {
        id: s.id,
        codigo: s.codigo,
        estado: s.estado,
        destino: s.destino,
        ...(da?.ritiro ? { ritiro: da.ritiro } : {}),
        eta: iso(s.etaPlan),
        ...(s.cliente ? { cliente: s.cliente } : {}),
        ...(autista ? { autista } : {}),
        ...(targa ? { targa } : {}),
        ...(s.tipoLabel ? { area: s.tipoLabel } : {}),
        ...(da ? { daPiazza: da.recordRemotoId } : {}),
        ...(gps ? { gps } : {}),
      };
    }),
  };
};
