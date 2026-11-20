import { prisma } from "../config/prisma.js";
import { AppError } from "../utils/AppError.js";
import { kmRecorrido } from "../utils/kmFacturables.js";
import { WORKED_WHERE } from "../utils/workedRecords.js";
import { getSignedUrlForKey } from "./storage.service.js";

// Lo que lee la app de finanzas (gamonal-finanzas) para la Planilla: quien trabaja, desde y hasta cuando tuvo servicios,
// y la produccion de un mes por persona (servicios, DHL, km y horas de manejo). Solo lectura, sin importes ni documentos.
// Va con la misma clave de servicio de OneSystec (X-Integration-Key).
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = "Europe/Rome";
// Sin servicios en estos dias = "sin entregas" (aunque la ficha siga ACTIVO).
export const DIAS_SIN_ENTREGAS = 14;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round1 = (v) => Math.round(v * 10) / 10;
const plateOf = (vehicle) => vehicle?.targa?.replace(/\s+/g, "").toUpperCase() ?? null;

// Medianoche de Italia de un dia (YYYY-MM-DD) como instante UTC.
const romeMidnight = (dia) => {
  const guess = new Date(`${dia}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(guess)
      .map((p) => [p.type, p.value])
  );
  const asRome = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess.getTime() - (asRome - guess.getTime()));
};
const romeDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);

export const rangoMes = (mes) => {
  const m = /^(\d{4})-(\d{2})$/.exec(mes || "");
  if (!m || +m[2] < 1 || +m[2] > 12) throw new AppError("mes invalido (YYYY-MM)", 400);
  const y = +m[1], mm = +m[2];
  const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  return { desde: romeMidnight(`${mes}-01`), hasta: romeMidnight(`${next}-01`) };
};

// Horas de manejo de un servicio: la jornada que declaro el chofer (fin - inicio - pausa). Si no la declaro, las horas
// dia + noche cargadas en el servicio. 0 si no hay nada.
export const horasServicio = (r) => {
  if (r.horaInicioReal && r.horaFinReal && r.horaFinReal > r.horaInicioReal) {
    const h = (r.horaFinReal - r.horaInicioReal) / 3600000 - num(r.pausaMin) / 60;
    if (h > 0 && h < 24) return { h, declarada: true };
  }
  const h = num(r.horasDia) + num(r.horasNoche);
  return { h, declarada: false };
};

const personaWhere = { cargo: { not: "CLIENTE" }, OR: [{ cargo: "CHOFER" }, { records: { some: {} } }] };

export const trabajadoresFinanzas = async ({ mes }) => {
  const { desde, hasta } = rangoMes(mes);
  const [users, hist, recs] = await Promise.all([
    prisma.user.findMany({
      where: personaWhere,
      select: {
        id: true, nombre: true, apellido: true, cargo: true, area: true, grupo: true, estado: true, numeroCelular: true,
        imagenPerfilKey: true, createdAt: true, vehiculoAsignado: { select: { targa: true } },
      },
      orderBy: [{ apellido: "asc" }, { nombre: "asc" }],
    }),
    prisma.record.groupBy({
      by: ["driverId"],
      where: WORKED_WHERE,
      _min: { fechaServicio: true },
      _max: { fechaServicio: true },
      _count: { _all: true },
    }),
    prisma.record.findMany({
      where: { AND: [WORKED_WHERE, { fechaServicio: { gte: desde, lt: hasta } }] },
      select: {
        driverId: true, estado: true, fechaServicio: true, spedizzione: true,
        kilometros: true, kilometrosReales: true, rutaDistanciaKm: true,
        horaInicioReal: true, horaFinReal: true, pausaMin: true, horasDia: true, horasNoche: true,
      },
    }),
  ]);

  const H = new Map(hist.map((g) => [g.driverId, g]));
  const ahora = Date.now();
  const trabajadores = await Promise.all(
    users.map(async (u) => {
      const g = H.get(u.id);
      const ultimo = g?._max.fechaServicio ?? null;
      const dias = ultimo ? Math.floor((ahora - ultimo.getTime()) / DAY_MS) : null;
      let foto = null;
      if (u.imagenPerfilKey) {
        try { foto = await getSignedUrlForKey(u.imagenPerfilKey, 6 * 3600); } catch { foto = null; }
      }
      return {
        id: u.id,
        nombre: `${u.nombre} ${u.apellido}`.trim(),
        cargo: u.cargo,
        area: u.area,
        grupo: u.grupo,
        estadoFicha: u.estado,
        telefono: u.numeroCelular?.trim() || null,
        vehiculo: plateOf(u.vehiculoAsignado),
        alta: u.createdAt.toISOString(),
        primerServicio: g?._min.fechaServicio ? romeDay(g._min.fechaServicio) : null,
        ultimoServicio: ultimo ? romeDay(ultimo) : null,
        diasSinServicio: dias,
        servicios: g?._count._all ?? 0,
        // Activo de verdad: ficha ACTIVO y con algun servicio en los ultimos DIAS_SIN_ENTREGAS dias.
        conEntregas: dias != null && dias <= DIAS_SIN_ENTREGAS,
        foto,
      };
    })
  );

  const P = new Map();
  for (const r of recs) {
    const k = r.driverId;
    if (!P.has(k)) P.set(k, { choferId: r.driverId, servicios: 0, dias: new Set(), dhl: 0, dhlEntregados: 0, kmDhl: 0, km: 0, horas: 0, horasDhl: 0, conHoras: 0, otros: {} });
    const p = P.get(k);
    const km = kmRecorrido(r);
    const { h, declarada } = horasServicio(r);
    p.servicios += 1;
    p.dias.add(romeDay(r.fechaServicio));
    p.km += km;
    p.horas += h;
    if (declarada) p.conHoras += 1;
    if (r.spedizzione === "DHL") {
      p.dhl += 1;
      if (r.estado === "CONSEGNATO") p.dhlEntregados += 1;
      p.kmDhl += km;
      p.horasDhl += h;
    } else {
      const t = r.spedizzione || "OTROS";
      p.otros[t] = (p.otros[t] || 0) + 1;
    }
  }
  const produccion = [...P.values()].map((p) => ({
    ...p,
    dias: p.dias.size,
    km: round1(p.km),
    kmDhl: round1(p.kmDhl),
    horas: round1(p.horas),
    horasDhl: round1(p.horasDhl),
  }));

  return { mes, generado: new Date().toISOString(), diasSinEntregas: DIAS_SIN_ENTREGAS, trabajadores, produccion };
};
