// Evalua lo que se le debe pagar a un chofer en un mes, servicio por servicio, y lo compara con lo que daba la regla anterior (km del circuito del sistema
// o km reales declarados, y la ruta "sin peaje" cuando el chofer lo marcaba). Solo lee: no cambia nada.
// Uso: node scripts/evaluar-pago-chofer.mjs --chofer "Kevin Fernandez" --mes 2026-10
import { PAY_TARIFFS, tariffForMonth } from "../src/config/payRates.js";
import { prisma } from "../src/config/prisma.js";
import { getPagosChoferesForActor } from "../src/services/finanzas.service.js";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const chofer = arg("--chofer");
const mes = arg("--mes") ?? new Date().toISOString().slice(0, 7);
if (!chofer) {
  console.error('Falta el chofer. Uso: node scripts/evaluar-pago-chofer.mjs --chofer "Nombre Apellido" --mes AAAA-MM');
  process.exit(1);
}

const palabras = chofer.split(/\s+/).filter(Boolean);
const candidatos = await prisma.user.findMany({
  where: { cargo: "CHOFER", AND: palabras.map((p) => ({ OR: [{ nombre: { contains: p, mode: "insensitive" } }, { apellido: { contains: p, mode: "insensitive" } }] })) },
  select: { id: true, nombre: true, apellido: true },
});
if (candidatos.length !== 1) {
  console.error(candidatos.length === 0 ? `No hay un chofer que se llame "${chofer}".` : `Hay varios: ${candidatos.map((c) => `${c.nombre} ${c.apellido}`).join(", ")}. Escribe el nombre completo.`);
  process.exit(1);
}
const driver = candidatos[0];

const actor = { id: "script", cargo: "OWNER" };
const tarifa = tariffForMonth(mes);
const tarifaVigente = PAY_TARIFFS.includes(tarifa);
const calcular = () => getPagosChoferesForActor(actor, { month: mes, driverId: driver.id });

const ahora = await calcular();
// Regla anterior: la misma tarifa sin los km planificados (vuelve a pagar el circuito / km reales).
const original = tarifa.pagoKmPlanificado;
tarifa.pagoKmPlanificado = false;
const antes = await calcular().finally(() => {
  tarifa.pagoKmPlanificado = original;
});

const ids = ahora.servicios.map((s) => s.id);
const extra = new Map(
  (await prisma.record.findMany({
    where: { id: { in: ids } },
    select: { id: true, spedizzione: true, kilometros: true, circuitoKm: true, circuitoKmBase: true, kilometrosReales: true, sinPeajeIda: true, sinPeajeVuelta: true },
  })).map((r) => [r.id, r])
);
const antesPorId = new Map(antes.servicios.map((s) => [s.id, s]));
const eur = (n) => (n == null ? "-" : n.toFixed(2));
const filas = ahora.servicios
  .slice()
  .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
  .map((s) => {
    const e = extra.get(s.id) ?? {};
    const a = antesPorId.get(s.id);
    return {
      fecha: new Date(s.fecha).toISOString().slice(0, 10),
      servicio: s.codigo,
      tipo: e.spedizzione ?? "",
      "km plan.": e.kilometros ?? "",
      "km circ.": e.circuitoKm ?? "",
      "km base": e.circuitoKmBase ?? "",
      "km reales": e.kilometrosReales ?? "",
      "sin peaje": e.sinPeajeIda || e.sinPeajeVuelta ? "SI" : "",
      "km antes": a?.km ?? "",
      "km ahora": s.incluidoEnViaje ? "(viaje)" : (s.km ?? ""),
      fuente: s.incluidoEnViaje ? `viaje ${s.viajeCodigo}` : s.kmFuente,
      "€ antes": eur(a?.total),
      "€ ahora": eur(s.total),
      "€ dif.": eur(s.total - (a?.total ?? 0)),
    };
  });

const totalAhora = ahora.porChofer[0]?.total ?? 0;
const totalAntes = antes.porChofer[0]?.total ?? 0;
console.log(`\n${driver.nombre} ${driver.apellido} - ${ahora.mesLabel}${tarifaVigente && tarifa.pagoKmPlanificado ? "" : "  (este mes NO tiene la regla de km planificados: ahora = antes)"}\n`);
console.table(filas);
const aviso = (n, texto) => n > 0 && console.log(`  - ${n} servicio(s) ${texto}`);
aviso(filas.filter((f) => f["sin peaje"]).length, 'con "sin peaje" declarado (ya no suben el pago)');
aviso(filas.filter((f) => f["km reales"] !== "").length, "con km reales declarados (ya no cuentan para el pago)");
aviso(ahora.servicios.filter((s) => s.kmFuente === "CIRCUITO").length, "sin km planificados: se pagaron con el circuito estandar (carga los km planificados)");
aviso(ahora.servicios.filter((s) => ["SIN_DATO", "VIAJE_SIN_CIRCUITO", "TRASPASO_SIN_KM"].includes(s.kmFuente)).length, "sin dato suficiente para pagar los km: REVISAR");
console.log(`\nTotal a pagar (con espera, reperibilidad y adicionales): ${eur(totalAhora)} EUR`);
console.log(`Con la regla anterior daba:                              ${eur(totalAntes)} EUR`);
console.log(`Diferencia:                                              ${eur(totalAhora - totalAntes)} EUR`);
console.log(`Km pagados ahora: ${ahora.porChofer[0]?.km ?? 0} | antes: ${antes.porChofer[0]?.km ?? 0}\n`);
await prisma.$disconnect();
