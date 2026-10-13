import { prisma } from "../config/prisma.js";
import { romeHHMM, romeLocalToDate, romeDay } from "../utils/romeTime.js";
import { multaAreaWhere, recordAreaWhere } from "../utils/areaAccess.js";
import { AppError } from "../utils/AppError.js";

// Quien pudo ser el responsable de una multa que no tiene chofer. SOLO SUGIERE: nunca asigna.
//
// Se cruza el vehiculo y el dia (y la hora, si el verbale la trae) de la infraccion con los servicios cargados:
//   - servicio en curso a esa hora ............. mas fuerte
//   - llevo la unidad ese dia .................. fuerte (mas si fue el unico)
//   - la llevo el dia anterior o siguiente ..... media (la unidad cambia de manos)
//   - la llevo 2-3 dias antes o despues ........ debil
//   - la llevaba antes y despues ............... suma un poco
//   - otra multa de la misma unidad esa fecha .. ya tiene chofer, suma
//   - multa por no comunicar los datos del conductor: el chofer de la multa original (el verbale que cita)
//   - un permiso aprobado ese dia lo descarta; el chofer habitual de la unidad solo desempata o es el plan B.
// Sin dia de infraccion solo se puede decir quien uso la unidad en los meses previos a recibirla (confianza baja).
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const WINDOW_DAYS = 3;
const NO_DATE_WINDOW_DAYS = 90;
const MAX_CANDIDATES = 3;
const MAX_BATCH = 20;

const dateOnlyToDay = (date) => date.toISOString().slice(0, 10);
const addDaysDay = (day, n) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`)) / DAY);
const normNumero = (s) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Un servicio cargado a mano o por la app tiene hora de verdad; los historicos importados traen solo el dia (00:00 / 01:00 / 02:00 en Roma).
const hasClockTime = (date) => {
  const [h, m] = romeHHMM(date).split(":").map(Number);
  return h >= 3 || m !== 0;
};

const serviceWindow = (s) => {
  const start = s.horaInicioReal ?? s.fechaRetiro ?? (hasClockTime(s.fechaServicio) ? s.fechaServicio : null);
  if (!start) return null;
  let end = s.horaFinReal ?? null;
  if (!end && s.rutaDuracionMin) end = new Date(start.getTime() + s.rutaDuracionMin * MIN);
  if (!end && s.eta && s.eta > start) end = s.eta;
  return { start, end: end ?? new Date(start.getTime() + 3 * 60 * MIN) };
};

// Referencias a otro verbale en los comentarios ("Verbale ref. 176/0958683", "Referencia 176/0959344", "...segun el PDF): 176/0989228.").
const REF_RE = /(?:verbale\s+ref\.?|verbale\s+referencia|verbale\s+referenciada|referencia|referenciada|ref\.|se refiere[^:]*:)\s*(?:verbale\s*)?:?\s*(\d{13}(?!\d)|\d{3}\s?[/ ]?\s?\d{7}(?!\d)|[A-Z]{1,3}\d{6,}|\d{4,8}[A-Z]?\/\d{4})/gi;
const extractRefs = (comentarios) => {
  const refs = new Set();
  for (const m of (comentarios ?? "").matchAll(REF_RE)) {
    const n = normNumero(m[1]);
    if (n.length >= 7) refs.add(n);
  }
  return [...refs];
};

const confidenceOf = (list) => {
  if (list.length === 0) return;
  const [top, second] = list;
  const clearLead = !second || top.score - second.score >= 40;
  if (top.referencia) top.confianza = "ALTA";
  else if (top.score >= 100 && clearLead) top.confianza = "ALTA";
  else if (top.score >= 50 && !list.some((c) => c !== top && c.dia > 0)) top.confianza = "ALTA";
  else if (top.score >= 50 || (top.score >= 25 && list.length === 1)) top.confianza = "MEDIA";
  else top.confianza = "BAJA";
  for (const c of list.slice(1)) c.confianza = c.score >= 50 ? "MEDIA" : "BAJA";
};

// multas: filas de Multa (id, vehicleId, driverId, fechaInfraccion, horaInfraccion, fechaRecepcion, comentarios, numeroVerbale).
// Devuelve un Map id -> { candidatos, modo, resumen, fechaBase, hora } (solo para las que no tienen chofer).
const suggestForMultas = async (multas, { recordFilter } = {}) => {
  const pending = multas.filter((m) => !m.driverId);
  const result = new Map();
  if (pending.length === 0) return result;

  // Multa original citada (por ejemplo la de "datos del conductor"): su chofer y, si hace falta, su dia y hora.
  const refsOf = new Map(pending.map((m) => [m.id, extractRefs(m.comentarios)]));
  const needsRefs = [...refsOf.values()].some((r) => r.length > 0);
  const allMultas = needsRefs
    ? await prisma.multa.findMany({
        select: { id: true, numeroVerbale: true, driverId: true, vehicleId: true, fechaInfraccion: true, horaInfraccion: true, driver: { select: { id: true, nombre: true, apellido: true } } },
      })
    : [];
  const byNumero = new Map(allMultas.map((m) => [normNumero(m.numeroVerbale), m]));
  // Exacto, o el numero citado esta dentro del verbale (por ejemplo "26570R/2026" dentro de "V/26570R/2026").
  const findByRef = (n) => byNumero.get(n) ?? allMultas.find((m) => normNumero(m.numeroVerbale).includes(n));

  // Ancla de cada multa: vehiculo + dia (+ hora) de la infraccion.
  const anchors = pending.map((m) => {
    const refMulta = (refsOf.get(m.id) ?? []).map(findByRef).find((r) => r && r.id !== m.id) ?? null;
    let { vehicleId } = m;
    let day = m.fechaInfraccion ? dateOnlyToDay(m.fechaInfraccion) : null;
    let hora = m.horaInfraccion ?? null;
    let viaRef = false;
    if (!day && refMulta?.fechaInfraccion) {
      day = dateOnlyToDay(refMulta.fechaInfraccion);
      hora = refMulta.horaInfraccion ?? null;
      vehicleId = vehicleId ?? refMulta.vehicleId;
      viaRef = true;
    }
    return { multa: m, vehicleId, day, hora, refMulta, viaRef };
  });

  const withVehicle = anchors.filter((a) => a.vehicleId);
  const ranges = withVehicle.map((a) => {
    const center = a.day ?? dateOnlyToDay(a.multa.fechaRecepcion);
    const from = a.day ? addDaysDay(center, -WINDOW_DAYS) : addDaysDay(center, -NO_DATE_WINDOW_DAYS);
    const to = a.day ? addDaysDay(center, WINDOW_DAYS + 1) : center;
    return { vehicleId: a.vehicleId, gte: romeLocalToDate(from, "00:00"), lt: romeLocalToDate(to, "00:00") };
  });

  const [services, neighbors, habituales] = await Promise.all([
    ranges.length
      ? prisma.record.findMany({
          where: {
            estado: { not: "ANNULLATO" },
            ...(recordFilter ?? {}),
            OR: ranges.map((r) => ({ vehicleId: r.vehicleId, fechaServicio: { gte: r.gte, lt: r.lt } })),
          },
          select: {
            vehicleId: true, fechaServicio: true, fechaRetiro: true, horaInicioReal: true, horaFinReal: true, eta: true, rutaDuracionMin: true,
            driver: { select: { id: true, nombre: true, apellido: true } },
          },
          orderBy: { fechaServicio: "asc" },
        })
      : [],
    withVehicle.some((a) => a.day)
      ? prisma.multa.findMany({
          where: { driverId: { not: null }, OR: withVehicle.filter((a) => a.day).map((a) => ({ vehicleId: a.vehicleId })) },
          select: { id: true, vehicleId: true, fechaInfraccion: true, driver: { select: { id: true, nombre: true, apellido: true } } },
        })
      : [],
    withVehicle.length
      ? prisma.user.findMany({
          where: { vehiculoAsignadoId: { in: [...new Set(withVehicle.map((a) => a.vehicleId))] }, estado: "ACTIVO" },
          select: { id: true, nombre: true, apellido: true, vehiculoAsignadoId: true },
        })
      : [],
  ]);

  // Choferes con permiso aprobado ese dia (se descartan).
  const permisoByKey = new Set();
  const driverIdsInPlay = [...new Set([...services.map((s) => s.driver.id), ...habituales.map((h) => h.id), ...neighbors.map((n) => n.driver.id)])];
  const days = anchors.filter((a) => a.day).map((a) => a.day);
  if (driverIdsInPlay.length && days.length) {
    const minDay = days.reduce((a, b) => (a < b ? a : b));
    const maxDay = days.reduce((a, b) => (a > b ? a : b));
    const permisos = await prisma.permiso.findMany({
      where: { driverId: { in: driverIdsInPlay }, estado: "APROBADO", fechaDesde: { lte: new Date(`${maxDay}T00:00:00.000Z`) }, fechaHasta: { gte: new Date(`${minDay}T00:00:00.000Z`) } },
      select: { driverId: true, fechaDesde: true, fechaHasta: true, tipo: true },
    });
    for (const a of anchors.filter((x) => x.day)) {
      for (const p of permisos) {
        if (dateOnlyToDay(p.fechaDesde) <= a.day && dateOnlyToDay(p.fechaHasta) >= a.day && p.tipo !== "DESCANSO") permisoByKey.add(`${a.multa.id}:${p.driverId}`);
      }
    }
  }

  for (const a of anchors) {
    const { multa, vehicleId, day, hora, refMulta, viaRef } = a;
    const base = { fechaBase: day, hora: day ? hora : null };
    const cands = new Map();
    const entry = (p) => {
      if (!cands.has(p.id)) cands.set(p.id, { id: p.id, nombre: p.nombre, apellido: p.apellido, dia: 0, adj: 0, cerca: 0, extra: 0, motivos: {}, services: 0, antes: false, despues: false });
      return cands.get(p.id);
    };

    // 1) multa original citada: mismo chofer
    if (refMulta?.driver) {
      const c = entry(refMulta.driver);
      c.referencia = true;
      c.extra += 120;
      c.motivos.ref = `Es el chofer de la multa original (verbale ${refMulta.numeroVerbale}), a la que se refiere esta.`;
    }

    if (!vehicleId) {
      result.set(multa.id, { ...base, modo: "sin-datos", resumen: "La targa de esta multa no esta en la flota: no se puede cruzar con los servicios.", candidatos: finish(cands, multa.id, permisoByKey) });
      continue;
    }

    const own = services.filter((s) => s.vehicleId === vehicleId);
    if (day) {
      for (const s of own) {
        const sDay = romeDay(s.fechaServicio);
        const diff = dayDiff(sDay, day);
        if (Math.abs(diff) > WINDOW_DAYS) continue;
        const c = entry(s.driver);
        if (diff === 0) {
          c.services += 1;
          const w = serviceWindow(s);
          let score = 50;
          let motivo = "Tuvo la unidad ese dia";
          if (hora && w) {
            const t = romeLocalToDate(day, hora).getTime();
            const inside = t >= w.start.getTime() - 30 * MIN && t <= w.end.getTime() + 30 * MIN;
            const gap = Math.min(Math.abs(t - w.start.getTime()), Math.abs(t - w.end.getTime()));
            if (inside) {
              score = 100;
              motivo = `Tenia un servicio en curso a las ${hora} (${romeHHMM(w.start)}-${romeHHMM(w.end)})`;
            } else if (gap <= 3 * 60 * MIN) {
              score = 60;
              motivo = `Tuvo la unidad ese dia, cerca de la hora (${romeHHMM(w.start)}-${romeHHMM(w.end)})`;
            } else {
              score = 40;
              motivo = `Tuvo la unidad ese dia, pero en otro horario (${romeHHMM(w.start)}-${romeHHMM(w.end)})`;
            }
          }
          if (score > c.dia) {
            c.dia = score;
            c.motivos.dia = motivo;
          }
        } else if (Math.abs(diff) === 1) {
          if (c.adj < 25) {
            c.adj = 25;
            c.motivos.adj = diff < 0 ? "La tuvo el dia anterior" : "La tuvo el dia siguiente";
          }
        } else if (c.cerca < 10) {
          c.cerca = 10;
          c.motivos.cerca = `La tuvo ${Math.abs(diff)} dias ${diff < 0 ? "antes" : "despues"}`;
        }
        if (diff < 0) c.antes = true;
        if (diff > 0) c.despues = true;
      }
      for (const c of cands.values()) {
        if (c.services > 1) c.extra += Math.min(15, (c.services - 1) * 5);
        if (c.antes && c.despues) {
          c.extra += 10;
          c.motivos.entre = "Tenia la unidad antes y despues de ese dia";
        }
      }
      // otras multas de la misma unidad esa fecha que ya tienen chofer
      for (const n of neighbors) {
        if (n.vehicleId !== vehicleId || n.id === multa.id || !n.fechaInfraccion) continue;
        if (Math.abs(dayDiff(dateOnlyToDay(n.fechaInfraccion), day)) <= 1) {
          const c = entry(n.driver);
          c.extra += 30;
          c.motivos.vecina = "Otra multa de esa unidad en esa fecha ya esta a su nombre";
        }
      }
    } else {
      // sin dia de infraccion: quien uso la unidad en los meses previos a recibir la multa
      const counts = new Map();
      for (const s of own) counts.set(s.driver.id, { driver: s.driver, n: (counts.get(s.driver.id)?.n ?? 0) + 1 });
      for (const { driver, n } of counts.values()) {
        const c = entry(driver);
        c.cerca = Math.min(30, n);
        c.motivos.cerca = `Uso la unidad ${n} ${n === 1 ? "vez" : "veces"} en los ${NO_DATE_WINDOW_DAYS} dias antes de recibir la multa`;
      }
    }

    // chofer habitual: solo desempata, o es el plan B si no hay nada mas
    for (const h of habituales.filter((x) => x.vehiculoAsignadoId === vehicleId)) {
      const c = cands.get(h.id) ?? (cands.size === 0 || [...cands.values()].every((x) => x.dia + x.adj + x.cerca + x.extra === 0) ? entry(h) : null);
      if (c) {
        c.extra += 10;
        c.motivos.habitual = "Es el chofer habitual de esa unidad";
      }
    }

    const list = finish(cands, multa.id, permisoByKey, day == null);
    let modo = day ? "preciso" : "aproximado";
    let resumen = null;
    if (!day) resumen = "Falta el dia de la infraccion: con ese dato la sugerencia seria mucho mas precisa.";
    else if (list.length === 0) {
      modo = "sin-datos";
      resumen = "Esa unidad no tiene servicios cargados cerca de esa fecha.";
    } else if (viaRef) resumen = "El dia y la hora salen de la multa original a la que se refiere esta.";
    if (day && !list.some((c) => c.confianza === "ALTA" || c.confianza === "MEDIA") && list.length > 0) resumen = resumen ?? "Hay varios choferes posibles: confirma con el verbale.";
    result.set(multa.id, { ...base, modo, resumen, candidatos: list });
  }
  return result;
};

const finish = (cands, multaId, permisoByKey, sinDia = false) => {
  const out = [];
  for (const c of cands.values()) {
    if (permisoByKey.has(`${multaId}:${c.id}`)) continue;
    // "Gamonal Trasporti" es el perfil de la empresa, no una persona que pueda haber manejado.
    if (`${c.nombre}${c.apellido}`.replace(/\s/g, "").toLowerCase() === "gamonaltrasporti") continue;
    const score = c.dia + c.adj + c.cerca + c.extra;
    if (score <= 0) continue;
    out.push({
      id: c.id,
      nombre: c.nombre,
      apellido: c.apellido,
      score,
      referencia: Boolean(c.referencia),
      dia: c.dia,
      motivos: [c.motivos.ref, c.motivos.dia, c.motivos.adj, c.motivos.cerca, c.motivos.entre, c.motivos.vecina, c.motivos.habitual].filter(Boolean),
    });
  }
  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, MAX_CANDIDATES);
  confidenceOf(top);
  if (sinDia) for (const c of top) if (!c.referencia) c.confianza = "BAJA";
  return top.map(({ dia, referencia, ...rest }) => rest);
};

const SELECT = {
  id: true, vehicleId: true, driverId: true, fechaInfraccion: true, horaInfraccion: true, fechaRecepcion: true, comentarios: true, numeroVerbale: true, area: true,
};

const assertOffice = (actor) => {
  if (actor.cargo !== "OWNER" && actor.cargo !== "ADMIN") throw new AppError("Solo la oficina puede ver las sugerencias de chofer", 403);
};

export const suggestDriverForMultaForActor = async (actor, id) => {
  assertOffice(actor);
  const multa = await prisma.multa.findFirst({ where: { id, ...(multaAreaWhere(actor) ?? {}) }, select: SELECT });
  if (!multa) throw new AppError("Multa no encontrada", 404);
  if (multa.driverId) return { candidatos: [], modo: "asignada", resumen: null, fechaBase: null, hora: null };
  const result = await suggestForMultas([multa], { recordFilter: recordAreaWhere(actor) });
  return result.get(id);
};

// Para las filas de un acordeon: { [multaId]: sugerencia } solo de las que no tienen chofer.
export const suggestDriversForMultasForActor = async (actor, ids) => {
  assertOffice(actor);
  const unique = [...new Set(ids)].slice(0, MAX_BATCH);
  const multas = await prisma.multa.findMany({ where: { id: { in: unique }, driverId: null, ...(multaAreaWhere(actor) ?? {}) }, select: SELECT });
  const result = await suggestForMultas(multas, { recordFilter: recordAreaWhere(actor) });
  return Object.fromEntries(result);
};
