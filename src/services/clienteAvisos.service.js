import { prisma } from "../config/prisma.js";
import { recordAreaKey, recordAreaWhere } from "../utils/areaAccess.js";
import { romeHHMM } from "../utils/romeTime.js";
import { sendPushToUserIds } from "./pushNotification.service.js";

// Avisos al celular de los usuarios de una empresa cliente (casilla AVISOS): cuando su servicio sale, cuando se atrasa, cuando llega y
// cuando se entrega. Los dispara el monitor de seguimiento (cada pocos minutos, ver runSeguimientoAlerts). Cada aviso se manda una sola vez
// por servicio (se guarda en AvisoCliente, asi sobrevive a un reinicio); el de retraso se repite solo si el atraso crece mucho.

const MIN_MS = 60 * 1000;
const RETRASO_REPETIR_MIN = 15;
const ENTREGADO_RECIENTE_MS = 30 * MIN_MS;
const GUARDAR_DIAS = 3;

const hora = (iso) => (iso ? romeHHMM(new Date(iso)) : null);

// servicios: los viajes en camino que calcula getSeguimiento (con clienteId). retrasoAvisoMin: desde cuantos minutos de atraso se avisa.
export const processClienteAvisos = async (servicios, now, { retrasoAvisoMin = 5 } = {}) => {
  // Destinatarios: usuarios cliente activos con la casilla de avisos, ligados a una empresa y/o a spedizioni (areas).
  const users = await prisma.user.findMany({
    where: {
      cargo: "CLIENTE",
      estado: "ACTIVO",
      clienteModulos: { has: "AVISOS" },
      OR: [{ clienteId: { not: null } }, { clienteAreas: { isEmpty: false } }],
    },
    select: { id: true, clienteId: true, clienteAreas: true },
  });
  if (!users.length) return;
  // A quien le toca un servicio: los de su empresa y los que siguen su spedizione.
  const recipientsOf = (clienteId, areaKey) =>
    users.filter((u) => (u.clienteId && u.clienteId === clienteId) || u.clienteAreas.includes(areaKey)).map((u) => u.id);

  const enCamino = servicios.filter((s) => recipientsOf(s.clienteId, s.tipo).length > 0);
  const empresas = [...new Set(users.map((u) => u.clienteId).filter(Boolean))];
  const areas = [...new Set(users.flatMap((u) => u.clienteAreas))];
  const alcance = [...(empresas.length ? [{ clientId: { in: empresas } }] : []), ...(areas.length ? [recordAreaWhere({ cargo: "ADMIN", areasPermitidas: areas })] : [])];
  const entregadosRaw = await prisma.record.findMany({
    where: { AND: [{ OR: alcance }, { estado: "CONSEGNATO", updatedAt: { gte: new Date(now - ENTREGADO_RECIENTE_MS) } }] },
    select: { id: true, codigo: true, clientId: true, spedizzione: true, extrasPiazzaZona: true, vehicle: { select: { targa: true } } },
  });
  const entregados = entregadosRaw
    .map((r) => ({ ...r, destinatarios: recipientsOf(r.clientId, recordAreaKey(r)) }))
    .filter((r) => r.destinatarios.length > 0);

  const ids = [...new Set([...enCamino.map((s) => s.id), ...entregados.map((r) => r.id)])];
  if (!ids.length) return;
  const previos = await prisma.avisoCliente.findMany({ where: { recordId: { in: ids } }, select: { recordId: true, tipo: true, valor: true } });
  const visto = new Map(previos.map((a) => [`${a.recordId}:${a.tipo}`, a]));
  const has = (id, tipo) => visto.has(`${id}:${tipo}`);

  const avisos = []; // { recordId, tipo, valor, destinatarios, title, body }
  for (const s of enCamino) {
    const targa = s.vehiculo ?? "";
    const base = { recordId: s.id, destinatarios: recipientsOf(s.clienteId, s.tipo) };
    if (!has(s.id, "SALIDA")) {
      avisos.push({
        ...base,
        tipo: "SALIDA",
        title: "Tu servicio salio",
        body: `${s.codigo}${targa ? ` (${targa})` : ""} va en camino${s.llegadaEstimada ? `. Llegada estimada: ${hora(s.llegadaEstimada)}` : ""}.`,
      });
    }
    const retraso = Math.max(0, s.retrasoMin ?? 0);
    const antes = visto.get(`${s.id}:RETRASO`);
    if (!s.llego && retraso >= retrasoAvisoMin && (!antes || retraso - (antes.valor ?? 0) >= RETRASO_REPETIR_MIN)) {
      avisos.push({
        ...base,
        tipo: "RETRASO",
        valor: retraso,
        title: "Tu servicio llegara con retraso",
        body: `${s.codigo}${targa ? ` (${targa})` : ""} llegara con ~${retraso} min de retraso${s.llegadaEstimada ? `, a las ${hora(s.llegadaEstimada)}` : ""}.`,
      });
    }
    if (s.llego && !has(s.id, "LLEGADA")) {
      avisos.push({ ...base, tipo: "LLEGADA", title: "Tu servicio llego", body: `${s.codigo}${targa ? ` (${targa})` : ""} llego a su destino${s.llegoAt ? ` a las ${hora(s.llegoAt)}` : ""}.` });
    }
  }
  const llegaron = new Set(avisos.filter((a) => a.tipo === "LLEGADA").map((a) => a.recordId));
  for (const r of entregados) {
    if (has(r.id, "ENTREGA")) continue;
    // Si ya se aviso que llego, la entrega queda anotada sin repetir la notificacion.
    const yaAvisadoLlegada = has(r.id, "LLEGADA") || llegaron.has(r.id);
    avisos.push({
      recordId: r.id,
      destinatarios: r.destinatarios,
      tipo: "ENTREGA",
      silencioso: yaAvisadoLlegada,
      title: "Servicio entregado",
      body: `${r.codigo}${r.vehicle?.targa ? ` (${r.vehicle.targa})` : ""} fue entregado.`,
    });
  }

  // Primero se anota (para no repetir si algo falla a mitad) y despues se manda.
  for (const a of avisos) {
    await prisma.avisoCliente.upsert({
      where: { recordId_tipo: { recordId: a.recordId, tipo: a.tipo } },
      create: { recordId: a.recordId, tipo: a.tipo, valor: a.valor ?? null },
      update: { valor: a.valor ?? null },
    });
  }
  await Promise.allSettled(
    avisos
      .filter((a) => !a.silencioso)
      .map((a) => sendPushToUserIds(a.destinatarios, { title: a.title, body: a.body, data: { type: "cliente-servicio", recordId: a.recordId, aviso: a.tipo.toLowerCase() } }))
  );

  await prisma.avisoCliente.deleteMany({ where: { createdAt: { lt: new Date(now - GUARDAR_DIAS * 24 * 60 * MIN_MS) } } }).catch(() => {});
};
