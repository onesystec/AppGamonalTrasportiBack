import { PAY_RATES, PAYABLE_STATUSES } from "../config/payRates.js";
import {
  findCombustibleLite,
  findPendingDeductions,
  findRecordsDetailed,
  findRecordsLite,
} from "../models/finanzas.model.js";
import { AppError } from "../utils/AppError.js";
import { getMancatoStatsForActor } from "./mancato.service.js";
import { getMultaStatsForActor } from "./multa.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const SERIES_MONTHS = 6;

const isPrivileged = (actor) => actor.cargo === "OWNER" || actor.cargo === "ADMIN";

const romeDay = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const round2 = (value) => Math.round(value * 100) / 100;
const pctChange = (current, previous) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

// "2026-10" -> primer dia del mes siguiente / n meses antes, siempre como "AAAA-MM".
const shiftMonth = (month, delta) => {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7);
};
const monthStartDate = (month) => new Date(`${month}-01T00:00:00.000Z`);
const monthLabel = (month) => `${MONTH_LABELS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

// Ventana de consulta con un dia de margen a cada lado: la zona horaria de Roma mueve el
// limite del mes unas horas y despues se filtra por el dia de Roma real.
const windowFor = (firstMonth, lastMonth) => ({
  from: new Date(monthStartDate(firstMonth).getTime() - DAY_MS),
  to: new Date(monthStartDate(shiftMonth(lastMonth, 1)).getTime() + DAY_MS),
});

const resolveMonth = (month) => month ?? romeDay().slice(0, 7);

// En el mes en curso se compara contra el mismo tramo del mes anterior (si no, a mitad de
// mes siempre parece que se gasta menos); en un mes cerrado, contra el mes anterior entero.
const comparisonLimitDay = (month) => (month === romeDay().slice(0, 7) ? Number(romeDay().slice(8, 10)) : 31);

// ---------------------------------------------------------------- pago a choferes

const numberOr0 = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// Pago de UN servicio. Con horas cargadas (dia + noche) se paga por hora; sin horas, por
// distancia (proporcional a cada 100 km); y las horas de espera se suman en ambos casos.
// Distancia: la que reporto el chofer si la cargo, si no la del servicio y, de ultima, la de
// la ruta calculada.
export const computeServicePay = (record) => {
  const horas = numberOr0(record.horasDia) + numberOr0(record.horasNoche);
  const esperaHoras = numberOr0(record.tiempoEspera);

  let modo = "HORAS";
  let km = null;
  let kmFuente = null;
  let pagoBase;
  if (horas > 0) {
    pagoBase = horas * PAY_RATES.horaEur;
  } else {
    modo = "KM";
    if (numberOr0(record.kilometrosReales) > 0) {
      km = record.kilometrosReales;
      kmFuente = "REAL";
    } else if (numberOr0(record.kilometros) > 0) {
      km = record.kilometros;
      kmFuente = "SERVICIO";
    } else if (numberOr0(record.rutaDistanciaKm) > 0) {
      km = record.rutaDistanciaKm;
      kmFuente = "RUTA";
    } else {
      km = 0;
      kmFuente = "SIN_DATO";
    }
    pagoBase = (km / 100) * PAY_RATES.cada100KmEur;
  }
  const pagoEspera = esperaHoras * PAY_RATES.esperaHoraEur;

  return {
    modo,
    horas: round2(horas),
    km: km == null ? null : round2(km),
    kmFuente,
    esperaHoras: round2(esperaHoras),
    pagoBase: round2(pagoBase),
    pagoEspera: round2(pagoEspera),
    total: round2(pagoBase + pagoEspera),
  };
};

const isPayable = (record) => PAYABLE_STATUSES.includes(record.estado);

const emptyPay = () => ({ total: 0, base: 0, espera: 0, servicios: 0, choferes: new Set() });
const addPay = (acc, record, pay) => {
  acc.total += pay.total;
  acc.base += pay.pagoBase;
  acc.espera += pay.pagoEspera;
  acc.servicios += 1;
  acc.choferes.add(record.driverId);
};
const finishPay = (acc) => ({
  total: round2(acc.total),
  base: round2(acc.base),
  espera: round2(acc.espera),
  servicios: acc.servicios,
  choferes: acc.choferes.size,
});

// ---------------------------------------------------------------- gastos de servicios

// Gastos que se cargan en el formulario del servicio. "Espera" (costoEspera) no entra: es
// lo que se le cobra al cliente por la espera, no un gasto. El combustible tampoco: se toma
// de Registro Combustible (los comprobantes), para no contarlo dos veces.
export const GASTO_CONCEPTOS = [
  { key: "peajes", label: "Peajes", color: "#2f8dff" },
  { key: "areaC", label: "Area C", color: "#ff8a1a" },
  { key: "costoTraforoFrejusBrennero", label: "Traforo Frejus/Brennero", color: "#a78bfa" },
  { key: "vignetta", label: "Vignetta", color: "#22d3ee" },
  { key: "costoHotel", label: "Hotel", color: "#ff3b57" },
  { key: "costoOtros", label: "Otros", color: "#8ea3c9" },
];

const recordGastos = (record) =>
  GASTO_CONCEPTOS.map((c) => ({ key: c.key, amount: numberOr0(record[c.key]) }));
const recordGastosTotal = (record) => recordGastos(record).reduce((sum, g) => sum + g.amount, 0);

const groupByConcepto = (records) =>
  GASTO_CONCEPTOS.map((c) => {
    const withAmount = records.filter((r) => numberOr0(r[c.key]) > 0);
    return {
      key: c.key,
      label: c.label,
      color: c.color,
      count: withAmount.length,
      total: round2(withAmount.reduce((sum, r) => sum + r[c.key], 0)),
    };
  })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.total - a.total);

// ---------------------------------------------------------------- resumen

const monthOfRecord = (record) => romeDay(record.fechaServicio).slice(0, 7);

export const getFinanzasResumenForActor = async (actor, query) => {
  const privileged = isPrivileged(actor);
  const month = resolveMonth(query.month);
  const firstMonth = shiftMonth(month, -(SERIES_MONTHS - 1));
  const { from, to } = windowFor(firstMonth, month);
  const driverId = privileged ? undefined : actor.id;

  const [records, fuel, mancato, multas] = await Promise.all([
    findRecordsLite({ from, to, driverId }),
    findCombustibleLite({
      from: monthStartDate(firstMonth),
      to: new Date(monthStartDate(shiftMonth(month, 1)).getTime() - DAY_MS),
      driverId,
    }),
    getMancatoStatsForActor(actor, {}),
    getMultaStatsForActor(actor, {}),
  ]);

  const limitDay = comparisonLimitDay(month);
  const prevMonth = shiftMonth(month, -1);
  const dayOfMonth = (iso) => Number(iso.slice(8, 10));

  const buckets = new Map();
  for (let i = 0; i < SERIES_MONTHS; i += 1) {
    buckets.set(shiftMonth(firstMonth, i), { combustible: 0, gastos: 0, pago: emptyPay(), gastosRecords: [] });
  }
  const prevSame = { combustible: 0, gastos: 0, pago: emptyPay() };

  for (const r of records) {
    const day = romeDay(r.fechaServicio);
    const bucket = buckets.get(day.slice(0, 7));
    if (!bucket) continue;
    const gastosTotal = recordGastosTotal(r);
    bucket.gastos += gastosTotal;
    if (gastosTotal > 0) bucket.gastosRecords.push(r);
    if (isPayable(r)) addPay(bucket.pago, r, computeServicePay(r));
    if (day.startsWith(prevMonth) && dayOfMonth(day) <= limitDay) {
      prevSame.gastos += gastosTotal;
      if (isPayable(r)) addPay(prevSame.pago, r, computeServicePay(r));
    }
  }
  for (const f of fuel) {
    const day = f.fecha.toISOString().slice(0, 10);
    const bucket = buckets.get(day.slice(0, 7));
    if (!bucket) continue;
    bucket.combustible += Number(f.monto);
    if (day.startsWith(prevMonth) && dayOfMonth(day) <= limitDay) prevSame.combustible += Number(f.monto);
  }

  const current = buckets.get(month);
  const pagoMes = finishPay(current.pago);
  const gastosMes = round2(current.gastos);
  const combustibleMes = round2(current.combustible);
  const cargasMes = fuel.filter((f) => f.fecha.toISOString().startsWith(month)).length;
  const prevPago = finishPay(prevSame.pago);

  const serie = [...buckets.entries()].map(([key, b]) => ({
    label: MONTH_LABELS[Number(key.slice(5, 7)) - 1],
    combustible: round2(b.combustible),
    gastosServicios: privileged ? round2(b.gastos) : 0,
    pagoChoferes: finishPay(b.pago).total,
  }));

  const rec = mancato.recomendacion;
  const recM = multas.recomendacion;
  const atencion = [];
  if (rec.vencidos > 0) {
    atencion.push({
      tone: "danger",
      title: `${rec.vencidos} ${rec.vencidos === 1 ? "mancato vencido" : "mancatos vencidos"}`,
      total: rec.totalVencido,
      to: "/finanzas/mancato",
    });
  }
  if (privileged && rec.sugeridos > 0) {
    atencion.push({
      tone: "warning",
      title: `${rec.sugeridos} ${rec.sugeridos === 1 ? "mancato por confirmar" : "mancatos por confirmar"} su servicio`,
      to: "/finanzas/mancato?asignacion=SUGERIDO",
    });
  }
  if (privileged && rec.enEspera > 0) {
    atencion.push({
      tone: "warning",
      title: `${rec.enEspera} ${rec.enEspera === 1 ? "mancato espera" : "mancatos esperan"} que se cargue su servicio`,
      to: "/finanzas/mancato?asignacion=EN_ESPERA",
    });
  }
  if (recM.vencidas > 0) {
    atencion.push({
      tone: "danger",
      title: `${recM.vencidas} ${recM.vencidas === 1 ? "multa vencida" : "multas vencidas"}`,
      total: recM.totalVencido,
      to: "/finanzas/multas",
    });
  }
  if (rec.porVencer3Dias > 0) {
    atencion.push({
      tone: "warning",
      title: `${rec.porVencer3Dias} ${rec.porVencer3Dias === 1 ? "mancato vence" : "mancatos vencen"} en 3 dias`,
      to: "/finanzas/mancato",
    });
  }
  if (recM.porVencer7Dias > 0) {
    atencion.push({
      tone: "warning",
      title: `${recM.porVencer7Dias} ${recM.porVencer7Dias === 1 ? "multa vence" : "multas vencen"} en 7 dias`,
      to: "/finanzas/multas",
    });
  }
  if (recM.aDescontarPendiente > 0) {
    atencion.push({
      tone: "warning",
      title: `${recM.aDescontarPendiente} ${recM.aDescontarPendiente === 1 ? "multa" : "multas"} por descontar`,
      total: recM.totalADescontar,
      to: "/finanzas/multas",
    });
  }

  return {
    month,
    mesLabel: monthLabel(month),
    esMesActual: month === romeDay().slice(0, 7),
    pendiente: {
      mancato: {
        total: mancato.totalPorPagar,
        abiertos: mancato.avisosAbiertos,
        vencidos: rec.vencidos,
        totalVencido: rec.totalVencido,
        porVencer3Dias: rec.porVencer3Dias,
      },
      multas: {
        total: multas.totalPorPagar,
        abiertas: multas.multasAbiertas,
        vencidas: recM.vencidas,
        totalVencido: recM.totalVencido,
        porVencer7Dias: recM.porVencer7Dias,
        aDescontar: multas.aDescontar,
      },
    },
    mes: {
      combustible: {
        total: combustibleMes,
        cargas: cargasMes,
        deltaPct: pctChange(combustibleMes, round2(prevSame.combustible)),
      },
      gastosServicios: privileged
        ? {
            total: gastosMes,
            servicios: current.gastosRecords.length,
            porConcepto: groupByConcepto(current.gastosRecords),
            deltaPct: pctChange(gastosMes, round2(prevSame.gastos)),
          }
        : null,
      pagoChoferes: { ...pagoMes, deltaPct: pctChange(pagoMes.total, prevPago.total) },
    },
    serie,
    atencion,
  };
};

// ---------------------------------------------------------------- detalle: pagos

const serviceItem = (record, pay) => ({
  id: record.id,
  codigo: record.codigo,
  fecha: record.fechaServicio,
  cliente: record.client?.nombre ?? null,
  destinazione: record.destinazione,
  ...pay,
});

export const getPagosChoferesForActor = async (actor, query) => {
  const privileged = isPrivileged(actor);
  const month = resolveMonth(query.month);
  const { from, to } = windowFor(month, month);
  // El chofer solo ve lo suyo, aunque pida otro.
  const driverId = privileged ? query.driverId : actor.id;

  const [allRecords, deductions] = await Promise.all([
    findRecordsDetailed({ from, to, driverId }),
    findPendingDeductions({ driverId }),
  ]);
  const records = allRecords.filter((r) => monthOfRecord(r) === month && isPayable(r));
  const deductionByDriver = new Map(
    deductions.map((d) => [d.driverId, { count: d._count._all, total: round2(Number(d._sum.costo ?? 0)) }])
  );

  const byDriver = new Map();
  const total = emptyPay();
  for (const r of records) {
    const pay = computeServicePay(r);
    addPay(total, r, pay);
    const entry =
      byDriver.get(r.driverId) ??
      {
        driverId: r.driverId,
        nombre: r.driver ? `${r.driver.nombre} ${r.driver.apellido}` : "Sin chofer",
        servicios: 0,
        horas: 0,
        km: 0,
        esperaHoras: 0,
        pagoBase: 0,
        pagoEspera: 0,
        total: 0,
        serviciosSinDato: 0,
      };
    entry.servicios += 1;
    entry.horas += pay.modo === "HORAS" ? pay.horas : 0;
    entry.km += pay.modo === "KM" ? (pay.km ?? 0) : 0;
    entry.esperaHoras += pay.esperaHoras;
    entry.pagoBase += pay.pagoBase;
    entry.pagoEspera += pay.pagoEspera;
    entry.total += pay.total;
    if (pay.kmFuente === "SIN_DATO") entry.serviciosSinDato += 1;
    byDriver.set(r.driverId, entry);
  }

  const porChofer = [...byDriver.values()]
    .map((e) => {
      const deduction = deductionByDriver.get(e.driverId) ?? { count: 0, total: 0 };
      const totalPago = round2(e.total);
      return {
        ...e,
        horas: round2(e.horas),
        km: round2(e.km),
        esperaHoras: round2(e.esperaHoras),
        pagoBase: round2(e.pagoBase),
        pagoEspera: round2(e.pagoEspera),
        total: totalPago,
        aDescontar: deduction,
        neto: round2(totalPago - deduction.total),
      };
    })
    .sort((a, b) => b.total - a.total);

  const showItems = !privileged || Boolean(driverId);
  return {
    month,
    mesLabel: monthLabel(month),
    reglas: PAY_RATES,
    total: finishPay(total),
    porChofer,
    servicios: showItems
      ? records.map((r) => serviceItem(r, computeServicePay(r))).sort((a, b) => b.fecha - a.fecha)
      : null,
  };
};

// ---------------------------------------------------------------- detalle: gastos de servicios

export const getGastosServiciosForActor = async (actor, query) => {
  // Son datos economicos del servicio: el chofer no los ve (igual que en Registros).
  if (!isPrivileged(actor)) throw new AppError("No tienes permisos para realizar esta accion", 403);
  const month = resolveMonth(query.month);
  const { from, to } = windowFor(month, month);

  const all = await findRecordsDetailed({ from, to });
  const records = all.filter((r) => monthOfRecord(r) === month && recordGastosTotal(r) > 0);

  const items = records
    .map((r) => ({
      id: r.id,
      codigo: r.codigo,
      fecha: r.fechaServicio,
      cliente: r.client?.nombre ?? null,
      destinazione: r.destinazione,
      driver: r.driver ? `${r.driver.nombre} ${r.driver.apellido}` : null,
      conceptos: Object.fromEntries(
        recordGastos(r)
          .filter((g) => g.amount > 0)
          .map((g) => [g.key, round2(g.amount)])
      ),
      total: round2(recordGastosTotal(r)),
    }))
    .sort((a, b) => b.fecha - a.fecha);

  return {
    month,
    mesLabel: monthLabel(month),
    total: round2(items.reduce((sum, i) => sum + i.total, 0)),
    servicios: items.length,
    porConcepto: groupByConcepto(records),
    items,
  };
};
