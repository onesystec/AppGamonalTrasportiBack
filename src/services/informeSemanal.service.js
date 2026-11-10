import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { resend } from "../config/resend.js";
import { romeDay, romeLocalToDate } from "../utils/romeTime.js";
import { WORKED_WHERE } from "../utils/workedRecords.js";
import { effectiveTolls } from "../utils/tollCost.js";
import { kmRecorrido } from "../utils/kmFacturables.js";
import { buildInformeSemanalEmail } from "../emails/informeSemanalEmail.js";

// Informe semanal de la flota por correo (ver retentionScheduler.js > startInformeSemanal): cada sabado temprano (hora de Roma)
// se manda a la oficina el resumen de la semana anterior completa, de sabado a viernes, por chofer:
//  - Peajes: los de cada servicio con el mismo criterio que el resto de la app (mancatos asignados si hay, si no el valor a mano,
//    ver utils/tollCost.js) mas los mancatos del chofer de esa semana que todavia no tienen servicio. Los avisos de mancato llegan
//    con dias de retraso, asi que el total de peajes de la semana puede crecer despues.
//  - Combustible: los comprobantes que se subieron con fecha de esa semana mas el valor a mano de los servicios sin comprobantes
//    (las dos fuentes nunca se suman sobre el mismo servicio, ver utils/fuelCost.js).
//  - Entregas DHL: los servicios DHL trabajados en la semana (y cuantos quedaron entregados).
//  - Km: los km recorridos de sus servicios (utils/kmFacturables.js > kmRecorrido) y, aparte, los km por GPS de cada vehiculo.
// Solo lectura: no cambia nada en la base salvo la marca de "ya enviado" en Configuracion.

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (value) => Math.round(value * 100) / 100;
const round1 = (value) => Math.round(value * 10) / 10;
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// "AAAA-MM-DD" + n dias (calendario, sin hora).
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 domingo ... 6 sabado

// Semana cerrada mas reciente (sabado a viernes, hora de Roma) respecto de "ahora": el sabado en que se envia el informe
// corresponde a la semana que termino el viernes anterior. "desdeDia" es el sabado de inicio y "hastaDia" el viernes de cierre.
export const semanaCerrada = (now = new Date()) => {
  const hoy = romeDay(now);
  const diasDesdeSabado = (weekdayOf(hoy) + 1) % 7; // sabado -> 0, domingo -> 1, ... viernes -> 6
  const sabadoActual = addDays(hoy, -diasDesdeSabado);
  return semanaDesde(addDays(sabadoActual, -7));
};

// Semana que empieza el sabado "desdeDia" ("AAAA-MM-DD").
export const semanaDesde = (desdeDia) => {
  if (weekdayOf(desdeDia) !== 6) throw new Error(`La semana del informe empieza en sabado (${desdeDia} no lo es)`);
  return periodoEntre(desdeDia, addDays(desdeDia, 6));
};

// Periodo cualquiera de "desdeDia" a "hastaDia" inclusive (hora de Roma); lo usan las pruebas con otras fechas.
export const periodoEntre = (desdeDia, hastaDia) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desdeDia) || !/^\d{4}-\d{2}-\d{2}$/.test(hastaDia) || hastaDia < desdeDia) {
    throw new Error(`Periodo del informe invalido: ${desdeDia} a ${hastaDia}`);
  }
  const finExclusivoDia = addDays(hastaDia, 1);
  return {
    desdeDia,
    hastaDia,
    // Instantes reales (hora de Roma) para los campos con hora y limites de fecha para las columnas @db.Date.
    desde: romeLocalToDate(desdeDia, "00:00"),
    hasta: romeLocalToDate(finExclusivoDia, "00:00"),
    desdeFecha: new Date(`${desdeDia}T00:00:00Z`),
    hastaFecha: new Date(`${finExclusivoDia}T00:00:00Z`),
  };
};

const nombreChofer = (driver) => (driver ? `${driver.nombre ?? ""} ${driver.apellido ?? ""}`.trim() || "Sin nombre" : "Sin chofer asignado");
const SIN_CHOFER = "__sin_chofer__";

// Junta los datos de la semana y arma el informe por chofer (no consulta nada mas que lo necesario).
export const cargarDatosSemana = async (semana) => {
  const driverSelect = { select: { id: true, nombre: true, apellido: true } };
  const [records, comprobantes, mancatosSinServicio, kmGps] = await Promise.all([
    prisma.record.findMany({
      where: { AND: [WORKED_WHERE, { fechaServicio: { gte: semana.desde, lt: semana.hasta } }] },
      select: {
        id: true,
        codigo: true,
        estado: true,
        fechaServicio: true,
        destinazione: true,
        ciudad: true,
        spedizzione: true,
        shipment: true,
        peajes: true,
        costoCombustible: true,
        kilometros: true,
        kilometrosReales: true,
        rutaDistanciaKm: true,
        driver: driverSelect,
        vehicle: { select: { targa: true } },
        client: { select: { nombre: true } },
        mancatos: { select: { costo: true } },
        _count: { select: { combustibles: true } },
      },
      orderBy: { fechaServicio: "asc" },
    }),
    prisma.registroCombustible.findMany({
      where: { fecha: { gte: semana.desdeFecha, lt: semana.hastaFecha } },
      select: {
        fecha: true,
        fechaHora: true,
        targa: true,
        metodo: true,
        monto: true,
        driver: driverSelect,
        record: { select: { codigo: true } },
      },
      orderBy: [{ fecha: "asc" }, { fechaHora: "asc" }],
    }),
    prisma.mancatoPagamento.findMany({
      where: { fecha: { gte: semana.desdeFecha, lt: semana.hastaFecha }, recordId: null },
      select: { numero: true, fecha: true, fechaHoraTransito: true, targa: true, costo: true, driver: driverSelect },
      orderBy: { fecha: "asc" },
    }),
    prisma.vehiculoKmDia.findMany({
      where: { dia: { gte: semana.desdeFecha, lt: semana.hastaFecha } },
      select: { km: true, vehiculo: { select: { targa: true, modelo: true } } },
    }),
  ]);
  return { records, comprobantes, mancatosSinServicio, kmGps };
};

// Puro (sin base): arma el informe a partir de los datos crudos. Separado para poder probarlo.
export const armarInforme = (semana, { records, comprobantes, mancatosSinServicio, kmGps }) => {
  const choferes = new Map();
  const chofer = (driver) => {
    const id = driver?.id ?? SIN_CHOFER;
    if (!choferes.has(id)) {
      choferes.set(id, {
        id,
        nombre: nombreChofer(driver),
        servicios: 0,
        km: 0,
        peajes: { total: 0, items: [] },
        combustible: { total: 0, items: [] },
        dhl: { total: 0, entregados: 0, items: [] },
      });
    }
    return choferes.get(id);
  };

  for (const r of records) {
    const c = chofer(r.driver);
    c.servicios += 1;
    c.km += kmRecorrido(r);

    const mancatosTotal = r.mancatos.reduce((sum, m) => sum + num(m.costo), 0);
    const tolls = effectiveTolls({ manual: r.peajes, mancatosTotal, mancatosCount: r.mancatos.length });
    if (tolls.total > 0) {
      c.peajes.total += tolls.total;
      c.peajes.items.push({
        fecha: r.fechaServicio,
        servicio: r.codigo,
        detalle: [r.client?.nombre, r.destinazione || r.ciudad].filter(Boolean).join(" · "),
        targa: r.vehicle?.targa ?? "",
        importe: tolls.total,
        fuente: tolls.fuente === "MANCATOS" ? `Mancato (${r.mancatos.length})` : "Cargado en el servicio",
      });
    }

    // Combustible a mano solo en servicios sin comprobantes (si hay comprobantes, ya se cuentan por su fecha abajo).
    if (r._count.combustibles === 0 && num(r.costoCombustible) > 0) {
      c.combustible.total += num(r.costoCombustible);
      c.combustible.items.push({
        fecha: r.fechaServicio,
        targa: r.vehicle?.targa ?? "",
        lugar: "Cargado en el servicio",
        servicio: r.codigo,
        importe: num(r.costoCombustible),
      });
    }

    if (r.spedizzione === "DHL") {
      c.dhl.total += 1;
      if (r.estado === "CONSEGNATO") c.dhl.entregados += 1;
      c.dhl.items.push({
        fecha: r.fechaServicio,
        servicio: r.codigo,
        shipment: r.shipment ?? "",
        destino: [r.destinazione, r.ciudad].filter(Boolean).join(", "),
        estado: r.estado,
        km: round1(kmRecorrido(r)),
      });
    }
  }

  for (const m of mancatosSinServicio) {
    const c = chofer(m.driver);
    c.peajes.total += num(m.costo);
    c.peajes.items.push({
      fecha: m.fechaHoraTransito ?? m.fecha,
      servicio: "",
      detalle: `Aviso ${m.numero} (todavia sin servicio asignado)`,
      targa: m.targa,
      importe: num(m.costo),
      fuente: "Mancato sin servicio",
    });
  }

  for (const f of comprobantes) {
    const c = chofer(f.driver);
    c.combustible.total += num(f.monto);
    c.combustible.items.push({
      fecha: f.fechaHora ?? f.fecha,
      targa: f.targa,
      lugar: f.metodo,
      servicio: f.record?.codigo ?? "",
      importe: num(f.monto),
    });
  }

  const vehiculos = new Map();
  for (const k of kmGps) {
    const key = k.vehiculo?.targa ?? "?";
    const v = vehiculos.get(key) ?? { targa: key, modelo: k.vehiculo?.modelo ?? "", km: 0, dias: 0 };
    v.km += num(k.km);
    v.dias += 1;
    vehiculos.set(key, v);
  }

  const byFecha = (a, b) => new Date(a.fecha) - new Date(b.fecha);
  const lista = [...choferes.values()]
    .map((c) => ({
      ...c,
      km: round1(c.km),
      peajes: { total: round2(c.peajes.total), items: c.peajes.items.sort(byFecha) },
      combustible: { total: round2(c.combustible.total), items: c.combustible.items.sort(byFecha) },
      dhl: { ...c.dhl, items: c.dhl.items.sort(byFecha) },
    }))
    // Los que mas gastaron primero; "sin chofer" siempre al final.
    .sort((a, b) => (a.id === SIN_CHOFER) - (b.id === SIN_CHOFER) || b.peajes.total + b.combustible.total - (a.peajes.total + a.combustible.total) || a.nombre.localeCompare(b.nombre));

  const totales = lista.reduce(
    (t, c) => ({
      servicios: t.servicios + c.servicios,
      km: t.km + c.km,
      peajes: t.peajes + c.peajes.total,
      combustible: t.combustible + c.combustible.total,
      dhl: t.dhl + c.dhl.total,
      dhlEntregados: t.dhlEntregados + c.dhl.entregados,
    }),
    { servicios: 0, km: 0, peajes: 0, combustible: 0, dhl: 0, dhlEntregados: 0 }
  );

  return {
    semana: { desdeDia: semana.desdeDia, hastaDia: semana.hastaDia },
    choferes: lista,
    vehiculos: [...vehiculos.values()].map((v) => ({ ...v, km: round1(v.km) })).sort((a, b) => b.km - a.km),
    totales: { ...totales, km: round1(totales.km), peajes: round2(totales.peajes), combustible: round2(totales.combustible) },
  };
};

export const generarInforme = async (semana) => armarInforme(semana, await cargarDatosSemana(semana));

// Excel con el detalle (una hoja por seccion), adjunto al correo.
export const buildInformeXlsx = async (informe) => {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Gamonal Trasporti";
  const NAVY = "FF0B1F33";
  const EUR = '"€" #,##0.00';
  const fmtFecha = (d) => {
    const s = romeDay(d);
    return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  };

  const sheet = (nombre, columns, rows) => {
    const ws = wb.addWorksheet(nombre, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    });
    rows.forEach((r) => ws.addRow(r));
    return ws;
  };

  const resumen = sheet(
    "Resumen",
    [
      { header: "Chofer", key: "chofer", width: 28 },
      { header: "Servicios", key: "servicios", width: 11 },
      { header: "Entregas DHL", key: "dhl", width: 13 },
      { header: "DHL entregadas", key: "dhlEntregados", width: 15 },
      { header: "Km", key: "km", width: 11, numFmt: "#,##0.0" },
      { header: "Peajes", key: "peajes", width: 13, numFmt: EUR },
      { header: "Combustible", key: "combustible", width: 14, numFmt: EUR },
    ],
    informe.choferes.map((c) => ({
      chofer: c.nombre,
      servicios: c.servicios,
      dhl: c.dhl.total,
      dhlEntregados: c.dhl.entregados,
      km: c.km,
      peajes: c.peajes.total,
      combustible: c.combustible.total,
    }))
  );
  const t = informe.totales;
  const totalRow = resumen.addRow({ chofer: "TOTAL", servicios: t.servicios, dhl: t.dhl, dhlEntregados: t.dhlEntregados, km: t.km, peajes: t.peajes, combustible: t.combustible });
  totalRow.font = { bold: true };

  sheet(
    "Peajes",
    [
      { header: "Chofer", key: "chofer", width: 26 },
      { header: "Fecha", key: "fecha", width: 12 },
      { header: "Servicio", key: "servicio", width: 16 },
      { header: "Detalle", key: "detalle", width: 44 },
      { header: "Targa", key: "targa", width: 11 },
      { header: "Fuente", key: "fuente", width: 22 },
      { header: "Importe", key: "importe", width: 12, numFmt: EUR },
    ],
    informe.choferes.flatMap((c) => c.peajes.items.map((i) => ({ chofer: c.nombre, ...i, fecha: fmtFecha(i.fecha) })))
  );

  sheet(
    "Combustible",
    [
      { header: "Chofer", key: "chofer", width: 26 },
      { header: "Fecha", key: "fecha", width: 12 },
      { header: "Targa", key: "targa", width: 11 },
      { header: "Gasolinera / origen", key: "lugar", width: 30 },
      { header: "Servicio", key: "servicio", width: 16 },
      { header: "Importe", key: "importe", width: 12, numFmt: EUR },
    ],
    informe.choferes.flatMap((c) => c.combustible.items.map((i) => ({ chofer: c.nombre, ...i, fecha: fmtFecha(i.fecha) })))
  );

  sheet(
    "Entregas DHL",
    [
      { header: "Chofer", key: "chofer", width: 26 },
      { header: "Fecha", key: "fecha", width: 12 },
      { header: "Servicio", key: "servicio", width: 16 },
      { header: "Shipment", key: "shipment", width: 16 },
      { header: "Destino", key: "destino", width: 40 },
      { header: "Estado", key: "estado", width: 14 },
      { header: "Km", key: "km", width: 9, numFmt: "#,##0.0" },
    ],
    informe.choferes.flatMap((c) => c.dhl.items.map((i) => ({ chofer: c.nombre, ...i, fecha: fmtFecha(i.fecha), estado: ESTADO_LABEL[i.estado] ?? i.estado })))
  );

  sheet(
    "Km por vehiculo (GPS)",
    [
      { header: "Targa", key: "targa", width: 12 },
      { header: "Modelo", key: "modelo", width: 26 },
      { header: "Dias con datos", key: "dias", width: 15 },
      { header: "Km", key: "km", width: 11, numFmt: "#,##0.0" },
    ],
    informe.vehiculos
  );

  return Buffer.from(await wb.xlsx.writeBuffer());
};

export const ESTADO_LABEL = {
  CONSEGNATO: "Entregado",
  IN_CONSEGNA: "En camino",
  IN_SOSPESO: "Pendiente",
  RITIRATO: "Retirado",
  ANNULLATO: "Anulado",
  RISCHEDULATO: "Reprogramado",
};

// Destinatarios: los de la variable INFORME_SEMANAL_DESTINATARIOS (separados por coma) o, si no esta, los de la oficina.
export const destinatariosInforme = () =>
  (env.INFORME_SEMANAL_DESTINATARIOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Genera y envia el informe de una semana. "prueba" marca el asunto para que se note que no es el envio oficial.
export const enviarInformeSemanal = async ({ semana = semanaCerrada(), destinatarios = destinatariosInforme(), prueba = false, presentacion = false } = {}) => {
  if (destinatarios.length === 0) throw new Error("No hay destinatarios para el informe semanal");
  const informe = await generarInforme(semana);
  const { subject, html, text } = buildInformeSemanalEmail(informe, { prueba, presentacion });
  const xlsx = await buildInformeXlsx(informe);
  const result = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: destinatarios,
    subject,
    html,
    text,
    attachments: [{ filename: `Informe flota ${informe.semana.desdeDia} a ${informe.semana.hastaDia}.xlsx`, content: xlsx }],
  });
  if (result?.error) throw new Error(result.error.message ?? "Resend no acepto el correo");
  return { semana: informe.semana, destinatarios, choferes: informe.choferes.length };
};

// Marca de "ya enviado" (en Configuracion) para no repetir el envio aunque el servidor se reinicie.
const CLAVE_ULTIMO_ENVIO = "informeSemanal.ultimaSemanaEnviada";
const CLAVE_PRUEBA = "informeSemanal.pruebaEnviada";
const CLAVE_PRESENTACION = "informeSemanal.presentacionEnviada";

const leerClave = async (clave) => (await prisma.configuracion.findUnique({ where: { clave } }))?.valor ?? null;
const guardarClave = (clave, valor) => prisma.configuracion.upsert({ where: { clave }, create: { clave, valor }, update: { valor } });

// Periodo de la prueba: INFORME_SEMANAL_PRUEBA_DESDE / _HASTA si estan las dos; si no, la ultima semana cerrada.
const periodoPrueba = (now) =>
  env.INFORME_SEMANAL_PRUEBA_DESDE && env.INFORME_SEMANAL_PRUEBA_HASTA
    ? periodoEntre(env.INFORME_SEMANAL_PRUEBA_DESDE, env.INFORME_SEMANAL_PRUEBA_HASTA)
    : semanaCerrada(now);

// Lo llama el scheduler cada pocos minutos. Envia el informe oficial el sabado a partir de la hora configurada (hora de Roma) y, si
// el servidor estuvo caido a esa hora, se pone al dia hasta el domingo. Ademas manda un informe de PRUEBA solo a
// INFORME_SEMANAL_PRUEBA_A una vez por cada periodo de prueba distinto (la primera vez que arranca con esta funcion, y otra vez
// solo si se cambia el periodo de prueba), para revisarlo antes de los envios oficiales.
export const tickInformeSemanal = async (now = new Date()) => {
  if (env.INFORME_SEMANAL_PRUEBA_A) {
    const periodo = periodoPrueba(now);
    const enviada = await leerClave(CLAVE_PRUEBA);
    const yaEnviada = enviada && (!env.INFORME_SEMANAL_PRUEBA_DESDE || (enviada.desdeDia === periodo.desdeDia && enviada.hastaDia === periodo.hastaDia));
    if (!yaEnviada) {
      await guardarClave(CLAVE_PRUEBA, { desdeDia: periodo.desdeDia, hastaDia: periodo.hastaDia, at: now.toISOString() });
      const r = await enviarInformeSemanal({ semana: periodo, destinatarios: [env.INFORME_SEMANAL_PRUEBA_A], prueba: true });
      console.log(`[informe-semanal] prueba enviada a ${env.INFORME_SEMANAL_PRUEBA_A} (periodo ${r.semana.desdeDia} a ${r.semana.hastaDia})`);
    }
  }

  // Envio de presentacion (una sola vez): el mismo informe del periodo de prueba a todos los destinatarios, avisando que desde
  // ahora les llegara cada sabado.
  if (env.INFORME_SEMANAL_PRESENTACION) {
    const ya = await leerClave(CLAVE_PRESENTACION);
    if (!ya) {
      const periodo = periodoPrueba(now);
      await guardarClave(CLAVE_PRESENTACION, { desdeDia: periodo.desdeDia, hastaDia: periodo.hastaDia, at: now.toISOString() });
      const r = await enviarInformeSemanal({ semana: periodo, presentacion: true });
      console.log(`[informe-semanal] presentacion enviada a ${r.destinatarios.length} destinatario(s) (periodo ${r.semana.desdeDia} a ${r.semana.hastaDia})`);
    }
  }

  const hoy = romeDay(now);
  const dia = weekdayOf(hoy);
  if (dia !== 6 && dia !== 0) return; // solo sabado (o domingo, para ponerse al dia)
  const horaRoma = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).find((p) => p.type === "hour")?.value
  );
  if (dia === 6 && horaRoma < env.INFORME_SEMANAL_HORA) return;

  const semana = semanaCerrada(now);
  const ultima = await leerClave(CLAVE_ULTIMO_ENVIO);
  if (ultima?.desdeDia === semana.desdeDia) return;

  // Se marca antes de enviar: si Resend falla, mejor un aviso en el log que correos repetidos cada pocos minutos.
  await guardarClave(CLAVE_ULTIMO_ENVIO, { desdeDia: semana.desdeDia, at: now.toISOString() });
  const r = await enviarInformeSemanal({ semana });
  console.log(`[informe-semanal] enviado a ${r.destinatarios.length} destinatario(s): semana ${r.semana.desdeDia} a ${r.semana.hastaDia}, ${r.choferes} chofer(es)`);
};
