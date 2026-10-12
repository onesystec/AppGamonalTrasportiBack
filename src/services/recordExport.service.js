import { findRecordsForFullExport } from "../models/record.model.js";
import { prisma } from "../config/prisma.js";
import { kmFacturables, kmMultiplier } from "../utils/kmFacturables.js";
import { romeLocalToDate } from "../utils/romeTime.js";
import { attachFaltantes } from "./faltantes.service.js";
import { listFilterForActor, matchesTimeRange, seccionesToWhere, toResponse } from "./record.service.js";

// Export CSV COMPLETO de Registros: una fila por servicio con TODA su informacion (haya o no dato), en columnas agrupadas: datos
// generales, fechas, chofer y vehiculo, ruta y paradas, circuito, estimacion, km, economico, jornada y horas, GPS, declaraciones y
// faltantes, traspaso, viaje compacto, reprogramacion, archivos y datos del sistema. Devuelve { columnas, filas } con los valores
// ya escritos como texto (fechas en hora de Roma, numeros con coma); el archivo CSV se arma en el frontend.

const ROME = "Europe/Rome";
const DAY_MS = 24 * 60 * 60 * 1000;

const fecha = (v) => (v ? new Date(v).toLocaleDateString("es-AR", { timeZone: ROME, day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const hora = (v) => (v ? new Date(v).toLocaleTimeString("es-AR", { timeZone: ROME, hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const fechaHora = (v) => (v ? `${fecha(v)} ${hora(v)}` : "");
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? "" : Number(v).toLocaleString("es-AR", { maximumFractionDigits: 2 }));
const sino = (v) => (v ? "Si" : "No");
const json = (v) => (v == null ? "" : JSON.stringify(v));
const personName = (p) => (p ? `${p.nombre} ${p.apellido}` : "");

const SECCION = { DHL: "DHL", AB_SERVICE: "AB Service", EXTRAS_STEFANIA: "Extras Stefania" };
const ZONA = { MILANO: "Milano", ROMA: "Roma" };
const ESTADO = { IN_SOSPESO: "En suspenso", IN_CONSEGNA: "En camino", CONSEGNATO: "Entregado", RITIRATO: "Retirado", RISCHEDULATO: "Reprogramado", ANNULLATO: "Anulado" };
const HORAS_ESTADO = { PENDIENTE: "Pendiente de aprobacion", APROBADAS: "Aprobadas", DEVUELTAS: "Devueltas" };
const MOTIVO = {
  CLIENTE_NO_ESTABA: "Cliente no estaba",
  AVERIA: "Averia",
  TRAFICO_CLIMA: "Trafico o clima",
  ERROR_DIRECCION: "Error de direccion",
  PEDIDO_CLIENTE: "Pedido del cliente",
  OTRO: "Otro",
};
const ASIGNACION = { AUTOMATICA: "automatica", MANUAL: "manual", EN_ESPERA: "en espera" };

const zonaOf = (r) => (r.extrasPiazzaZona ? ZONA[r.extrasPiazzaZona] : ["DHL", "AB_SERVICE"].includes(r.spedizzione) ? "Milano" : "Sin zona");

// Cada columna: [titulo, (registro crudo, respuesta calculada, contexto) => valor]. Un servicio sin ese dato deja la celda vacia.
const COLUMNAS = [
  // --- Datos generales
  ["ID", (r) => r.id],
  ["Codigo", (r) => r.codigo],
  ["Estado", (r) => ESTADO[r.estado] ?? r.estado],
  ["Seccion", (r) => SECCION[r.spedizzione] ?? "Extras Piazza"],
  ["Zona", (r) => zonaOf(r)],
  ["Aplicativo", (r) => r.aplicativo ?? ""],
  ["Cliente", (r) => r.client?.nombre ?? ""],
  ["Descripcion", (r) => r.descripcion ?? ""],
  ["Ciudad", (r) => r.ciudad ?? ""],
  ["Destino", (r) => r.destinazione ?? ""],
  // --- Fechas
  ["Fecha del servicio", (r) => fecha(r.fechaServicio)],
  ["Hora (ETA)", (r) => hora(r.eta)],
  ["ETA (fecha y hora)", (r) => fechaHora(r.eta)],
  ["Salida / fecha retiro", (r) => fechaHora(r.fechaRetiro)],
  ["Retiro del paquete", (r) => fechaHora(r.retiroPaqueteAt)],
  // --- Chofer y vehiculo
  ["Chofer", (r) => personName(r.driver)],
  ["ID chofer", (r) => r.driverId],
  ["Vehiculo (targa)", (r) => r.vehicle?.targa ?? ""],
  ["Vehiculo (modelo)", (r) => r.vehicle?.modelo ?? ""],
  ["Vehiculo (categoria)", (r) => r.vehicle?.categoria ?? ""],
  // --- Ruta y paradas
  ["Punto de salida", (r) => r.salidaDireccion ?? ""],
  ["Salida (latitud)", (r) => (r.salidaLat != null ? String(r.salidaLat) : "")],
  ["Salida (longitud)", (r) => (r.salidaLng != null ? String(r.salidaLng) : "")],
  ["Pasa por Brennero", (r) => sino(r.pasaPorBrennero)],
  ["Cantidad de paradas", (r) => String(r.stops.length)],
  ["Paradas", (r) => r.stops.map((s, i) => `${i + 1}) ${s.direccion}`).join(" | ")],
  ["Paradas (con coordenadas)", (r) => r.stops.map((s, i) => `${i + 1}) ${s.direccion}${s.lat != null ? ` [${s.lat}, ${s.lng}]` : " [sin ubicar]"}`).join(" | ")],
  ["Km de la ruta", (r) => num(r.rutaDistanciaKm)],
  ["Duracion de la ruta (min)", (r) => num(r.rutaDuracionMin)],
  ["Ruta calculada el", (r) => fechaHora(r.rutaCalculadaAt)],
  // --- Circuito planificado
  ["Circuito (km totales)", (r) => num(r.circuito?.km)],
  ["Circuito ida (km)", (r) => num(r.circuito?.idaKm)],
  ["Circuito ida (min)", (r) => num(r.circuito?.idaMin)],
  ["Circuito vuelta (km)", (r) => num(r.circuito?.vueltaKm)],
  ["Circuito vuelta (min)", (r) => num(r.circuito?.vueltaMin)],
  ["Circuito (lugar de espera)", (r) => r.circuito?.base?.nombre ?? ""],
  ["Circuito (peajes de ida)", (r) => (r.circuito?.peajes?.ida ?? []).join(" | ")],
  ["Circuito (peajes de vuelta)", (r) => (r.circuito?.peajes?.vuelta ?? []).join(" | ")],
  ["Circuito (origen del calculo)", (r) => r.circuito?.fuente ?? ""],
  ["Circuito calculado el", (r) => fechaHora(r.circuito?.calculadaAt)],
  // --- Estimacion por ruta
  ["Estimacion: inicio", (r) => fechaHora(r.estimacionRuta?.inicioAt)],
  ["Estimacion: ultima entrega", (r) => fechaHora(r.estimacionRuta?.ultimaEntregaAt)],
  ["Estimacion: fin", (r) => fechaHora(r.estimacionRuta?.finEstimadoAt)],
  ["Estimacion: total (min)", (r) => num(r.estimacionRuta?.totalMin)],
  ["Estimacion: conduccion ida (min)", (r) => num(r.estimacionRuta?.conduccionIdaMin)],
  ["Estimacion: conduccion vuelta (min)", (r) => num(r.estimacionRuta?.conduccionVueltaMin)],
  ["Estimacion: paradas (min)", (r) => num(r.estimacionRuta?.paradasMin)],
  ["Estimacion: descansos (min)", (r) => num(r.estimacionRuta?.descansosMin)],
  // --- Kilometros y tarifa
  ["Km del cliente (planificados)", (r) => num(r.kilometros)],
  ["Multiplicador de km", (r) => String(kmMultiplier(r))],
  ["Km facturables", (r) => num(kmFacturables(r))],
  ["Km reales", (r) => num(r.kilometrosReales)],
  ["Diferencia de km (reales - facturables)", (r, f) => num(f.diferenciaKm)],
  ["Precio por km", (r) => num(r.precioKm)],
  ["Total por km", (r, f) => num(f.totalKm)],
  // --- Economico
  ["Area C", (r) => num(r.areaC)],
  ["Costo de espera", (r) => num(r.costoEspera)],
  ["Traforo Frejus/Brennero", (r) => num(r.costoTraforoFrejusBrennero)],
  ["Peajes (efectivos)", (r, f) => num(f.peajes)],
  ["Peajes cargados a mano", (r) => num(r.peajes)],
  ["Peajes asignados (cantidad)", (r) => String(r.mancatos.length)],
  [
    "Peajes asignados (detalle)",
    (r) => r.mancatos.map((m) => `${m.numero} ${fechaHora(m.fechaHoraTransito)} ${m.tramo ?? "sin tramo"} EUR ${num(m.costo)}${m.pagado ? " pagado" : " sin pagar"}`).join(" | "),
  ],
  ["Vignetta", (r) => num(r.vignetta)],
  ["Hotel", (r) => num(r.costoHotel)],
  ["Otros costos", (r) => num(r.costoOtros)],
  ["Combustible (efectivo)", (r, f) => num(f.costoCombustible)],
  ["Combustible cargado a mano", (r) => num(r.costoCombustible)],
  ["Comprobantes de combustible (cantidad)", (r) => String(r.combustibles.length)],
  ["Comprobantes de combustible (total)", (r) => num(r.combustibles.reduce((sum, c) => sum + Number(c.monto), 0))],
  [
    "Comprobantes de combustible (detalle)",
    (r) => r.combustibles.map((c) => `${fechaHora(c.fechaHora)} EUR ${num(c.monto)} ${c.metodo}`).join(" | "),
  ],
  ["Total sin combustible", (r, f) => num(f.total)],
  ["Monto recibido", (r) => num(r.pagoRecibido)],
  ["Facturacion esperada", (r, f) => num(f.facturacion?.esperado)],
  ["Facturacion: diferencia", (r, f) => num(f.facturacion?.diferencia)],
  ["Cliente confirmado", (r) => sino(r.clienteConfirmado)],
  // --- Jornada y horas
  ["Inicio real de la jornada", (r) => fechaHora(r.horaInicioReal)],
  ["Fin real de la jornada", (r) => fechaHora(r.horaFinReal)],
  ["Pausa (min)", (r) => num(r.pausaMin)],
  ["Espera (horas)", (r) => num(r.tiempoEspera)],
  ["Horas de dia", (r) => num(r.horasDia)],
  ["Horas de noche", (r) => num(r.horasNoche)],
  ["Estado de las horas", (r) => (r.horasEstado ? (HORAS_ESTADO[r.horasEstado] ?? r.horasEstado) : "")],
  ["Horas enviadas el", (r) => fechaHora(r.horasEnviadasAt)],
  ["Horas revisadas el", (r) => fechaHora(r.horasRevisadasAt)],
  ["Horas revisadas por", (r, f, ctx) => ctx.users.get(r.horasRevisadaPorId) ?? ""],
  ["Nota de las horas", (r) => r.horasNota ?? ""],
  ["Horas aprobadas automaticamente", (r) => sino(r.horasDeclaradas?.autoAprobada)],
  ["Termino fuera de la base", (r) => sino(r.finFueraDeBase)],
  ["Horas declaradas por el chofer (detalle)", (r) => json(r.horasDeclaradas)],
  // --- GPS y manejo
  ["Llegada segun GPS", (r) => fechaHora(r.llegadaGpsAt)],
  ["Paradas del vehiculo calculadas el", (r) => fechaHora(r.paradasCalculadasAt)],
  ["GPS al final de la jornada (detalle)", (r) => json(r.gpsFin)],
  ["Estilo de manejo: km", (r) => num(r.estiloManejo?.km)],
  ["Estilo de manejo: calidad", (r) => r.estiloManejo?.calidad ?? ""],
  ["Estilo de manejo: incidentes (detalle)", (r) => json(r.estiloManejo?.incidentes)],
  ["Estilo de manejo calculado el", (r) => fechaHora(r.estiloCalculadoAt)],
  // --- Declaraciones del chofer y faltantes
  ["Sin peaje de ida (declarado)", (r) => sino(r.sinPeajeIda)],
  ["Sin peaje de vuelta (declarado)", (r) => sino(r.sinPeajeVuelta)],
  ["Sin combustible (declarado)", (r) => sino(r.sinCombustible)],
  ["Faltantes pendientes (cantidad)", (r, f) => (f.faltantes ? String(f.faltantes.pendientes) : "")],
  ["Falta peaje de ida", (r, f) => (f.faltantes ? sino(f.faltantes.ida) : "")],
  ["Falta peaje de vuelta", (r, f) => (f.faltantes ? sino(f.faltantes.vuelta) : "")],
  ["Falta combustible", (r, f) => (f.faltantes ? sino(f.faltantes.combustible) : "")],
  ["Aviso de faltantes enviado el", (r) => fechaHora(r.faltantesAvisadoAt)],
  ["Excepcion de faltantes", (r) => sino(r.faltantesExcepcion)],
  ["Excepcion: motivo", (r) => r.faltantesExcepcionNota ?? ""],
  ["Excepcion: puesta por", (r, f, ctx) => ctx.users.get(r.faltantesExcepcionPor) ?? ""],
  ["Excepcion: fecha", (r) => fechaHora(r.faltantesExcepcionAt)],
  // --- Traspaso entre choferes
  ["Traspaso: servicio de origen", (r) => r.servicioOrigen?.codigo ?? ""],
  ["Traspaso: chofer del servicio de origen", (r) => personName(r.servicioOrigen?.driver)],
  ["Traspaso: hora en que recibio el paquete", (r) => fechaHora(r.traspasoHora)],
  ["Traspaso: servicio del chofer que lo termina", (r) => r.continuaciones.map((c) => c.codigo).join(" | ")],
  ["Traspaso: chofer que lo termina", (r) => r.continuaciones.map((c) => personName(c.driver)).join(" | ")],
  // --- Viaje compacto
  ["Viaje compacto (ID)", (r) => r.compactadoId ?? ""],
  ["Viaje compacto (orden)", (r) => (r.compactadoOrden != null ? String(r.compactadoOrden) : "")],
  ["Reparto de km del viaje (detalle)", (r) => json(r.kmReparto)],
  // --- Reprogramacion
  ["Reprogramado el", (r) => fechaHora(r.reprogramadoAt)],
  ["Reprogramacion: km planificados antes", (r) => num(r.reprogramacion?.kmPlanificados)],
  ["Reprogramacion: km hechos por el chofer", (r) => num(r.reprogramacion?.kmHechos)],
  ["Reprogramacion: motivo", (r) => MOTIVO[r.reprogramacion?.motivo] ?? r.reprogramacion?.motivo ?? ""],
  ["Reprogramacion: nuevo servicio", (r) => r.reprogramacion?.nuevoCodigo ?? ""],
  ["Reprogramacion: nueva ETA", (r) => fechaHora(r.reprogramacion?.nuevaEta)],
  ["Reprogramacion: hecha por", (r, f, ctx) => ctx.users.get(r.reprogramacion?.porId) ?? ""],
  ["Es la reprogramacion de", (r) => r.reprogramadoDe?.codigo ?? ""],
  // --- Archivos
  ["Archivos (cantidad)", (r) => String(r.files.length)],
  ["Archivos (tipos)", (r) => [...new Set(r.files.map((x) => x.tipoArchivo))].join(" | ")],
  // --- Sistema
  ["ID externo (AppSheet)", (r) => r.origenExternoId ?? ""],
  ["Fallo la escritura en AppSheet", (r) => sino(r.appsheetSyncFallido)],
  ["Creado el", (r) => fechaHora(r.createdAt)],
  ["Actualizado el", (r) => fechaHora(r.updatedAt)],
  // --- Comentarios (al final: puede ser un texto largo)
  ["Comentarios", (r) => r.comentarios ?? ""],
];

// "from"/"to" llegan como fechas (AAAA-MM-DD, "to" inclusive): se leen como dias de Roma, igual que en el resto de la app.
const dayString = (d, plusDays = 0) => new Date(new Date(d).getTime() + plusDays * DAY_MS).toISOString().slice(0, 10);
const romeRange = (from, to) => {
  if (!from && !to) return undefined;
  return {
    gte: from ? romeLocalToDate(dayString(from), "00:00") : new Date(0),
    lt: to ? romeLocalToDate(dayString(to, 1), "00:00") : new Date(Date.now() + DAY_MS),
  };
};

export const exportFullRecordsForActor = async (actor, filters) => {
  const { from, to, fromTime, toTime, driverId, clientId, vehicleId, secciones, zonas, estados } = filters;
  const records = await findRecordsForFullExport({
    dateRange: romeRange(from, to),
    spedizzioneFilter: listFilterForActor(actor),
    driverId,
    clientId,
    vehicleId,
    seccionWhere: seccionesToWhere(secciones),
    zonaValues: zonas,
    estadoValues: estados,
  });
  const inRange = records.filter((r) => matchesTimeRange(r, fromTime, toTime));

  // Nombres de quien reviso las horas, puso una excepcion o reprogramo (solo guardan el id).
  const userIds = new Set();
  for (const r of inRange) {
    for (const id of [r.horasRevisadaPorId, r.faltantesExcepcionPor, r.reprogramacion?.porId]) if (id) userIds.add(id);
  }
  const users = new Map(
    userIds.size
      ? (await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, nombre: true, apellido: true } })).map((u) => [u.id, personName(u)])
      : []
  );

  // Totales y faltantes calculados como en el resto de la app (ya con los peajes y comprobantes de cada servicio cargados).
  await attachFaltantes(inRange);
  const filas = inRange.map((record) => {
    const calculado = toResponse(record, actor);
    return COLUMNAS.map(([, valor]) => String(valor(record, calculado, { users }) ?? ""));
  });
  return { columnas: COLUMNAS.map(([titulo]) => titulo), filas };
};
