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

// Largos maximos del contrato con la otra app (se recorta, no se rechaza: un texto largo no debe tirar el servicio).
export const LIMITES_VIVO = { id: 100, codigo: 100, destino: 300, ritiro: 300, cliente: 150, autista: 120, targa: 30, area: 60 };
export const recorta = (valor, max) => {
  const t = typeof valor === "string" ? valor.trim() : valor == null ? "" : String(valor).trim();
  return t.length > max ? t.slice(0, max).trim() : t;
};

// El destino que se manda debe ser una direccion real que la otra app pueda geocodificar, no un texto como "Giro (2 tappe)".
export const esDireccionUtil = (texto) => {
  const t = String(texto ?? "").trim();
  return t.length > 0 && !/^giro\b/i.test(t);
};

// Posicion real del vehiculo (nunca la simulada) con su hora; sin hora no se manda (no se inventa ni se reutiliza una vieja sin fecha).
const gpsDi = (gps) => {
  if (!gps || gps.fuente === "SIMULADO" || gps.lat == null || gps.lng == null || !gps.actualizada) return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  const fecha = new Date(gps.actualizada);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || Number.isNaN(fecha.getTime())) return null;
  const rumbo = Number(gps.rumbo);
  return { lat, lng, ...(gps.rumbo != null && Number.isFinite(rumbo) && rumbo >= 0 && rumbo <= 360 ? { rumbo } : {}), actualizada: fecha.toISOString() };
};

// Un servicio del seguimiento -> el formato que se comparte. Solo estos campos (nada de importes, documentos ni datos personales).
// da = { recordRemotoId, ritiro } si llego por esta conexion; destino = direccion ya resuelta.
export const aServizioVivo = (s, { da = null, destino }) => {
  const autista = s.chofer?.nombre && s.chofer.nombre !== SIN_ASIGNAR_NOMBRE ? recorta(s.chofer.nombre, LIMITES_VIVO.autista) : "";
  const targa = s.vehiculo && s.vehiculo !== SIN_ASIGNAR_TARGA ? recorta(s.vehiculo, LIMITES_VIVO.targa) : "";
  const gps = gpsDi(s.gps);
  const ritiro = da?.ritiro ? recorta(da.ritiro, LIMITES_VIVO.ritiro) : "";
  const cliente = s.cliente ? recorta(s.cliente, LIMITES_VIVO.cliente) : "";
  const area = s.tipoLabel ? recorta(s.tipoLabel, LIMITES_VIVO.area) : "";
  return {
    id: recorta(s.id, LIMITES_VIVO.id),
    codigo: recorta(s.codigo, LIMITES_VIVO.codigo),
    estado: s.estado,
    destino: recorta(destino, LIMITES_VIVO.destino),
    ...(ritiro ? { ritiro } : {}),
    eta: iso(s.etaPlan),
    ...(cliente ? { cliente } : {}),
    ...(autista ? { autista } : {}),
    ...(targa ? { targa } : {}),
    ...(area ? { area } : {}),
    ...(da ? { daPiazza: recorta(da.recordRemotoId, LIMITES_VIVO.id) } : {}),
    ...(gps ? { gps } : {}),
  };
};

export const serviziInCorso = async (riga) => {
  if (riga.stato !== "ATTIVO" || riga.ruolo !== "CLIENTE") throw new AppError("Il collegamento non è attivo", 409);
  if (!riga.condividiServiziInCorso) throw new AppError("Questo collegamento non condivide i servizi in corso", 403);

  const { servicios } = await allSeguimiento();
  // Los vehiculos que el Owner oculta del mapa tampoco se comparten.
  const { visibles } = await filtrarParaOficina(servicios.filter((s) => ESTADI_VIVO.has(s.estado)));
  // Por hora prevista de llegada (el seguimiento ya viene asi; se asegura aqui) y como mucho 300.
  const lista = [...visibles].sort((a, b) => new Date(a.etaPlan) - new Date(b.etaPlan)).slice(0, MAX_SERVIZI_VIVO);
  const ids = lista.map((s) => s.id);

  // De los que llegaron por ESTA conexion: el id del servicio en la otra app (y su ritiro). Los de otras conexiones no se marcan.
  const origen = ids.length
    ? await prisma.solicitudServicio.findMany({
        where: { recordId: { in: ids }, collegamentoId: riga.id, recordRemotoId: { not: null } },
        select: { recordId: true, recordRemotoId: true, ritiro: true },
      })
    : [];
  const porRecord = new Map(origen.map((o) => [o.recordId, o]));

  // Destino: el del seguimiento (ultima parada con direccion). Si no es una direccion usable (p. ej. "Giro (2 tappe)"), la ultima parada real del servicio;
  // esa consulta solo se hace para esos pocos casos.
  const dudosos = lista.filter((s) => !esDireccionUtil(s.destino)).map((s) => s.id);
  const paradas = dudosos.length ? await prisma.recordStop.findMany({ where: { recordId: { in: dudosos } }, orderBy: { orden: "asc" }, select: { recordId: true, direccion: true } }) : [];
  const ultimaParada = new Map();
  for (const p of paradas) if (esDireccionUtil(p.direccion)) ultimaParada.set(p.recordId, p.direccion);

  const servizi = [];
  for (const s of lista) {
    try {
      const destino = esDireccionUtil(s.destino) ? s.destino : ultimaParada.get(s.id);
      // Sin ninguna direccion que la otra app pueda ubicar, el servicio no se manda (no tendria recorrido que dibujar).
      if (!destino || !s.etaPlan) continue;
      servizi.push(aServizioVivo(s, { da: porRecord.get(s.id) ?? null, destino }));
    } catch (err) {
      // Un servicio con datos raros no tira a los demas.
      console.error("[collegamenti] servicio omitido en /vivo:", err.message);
    }
  }
  return { servizi };
};
