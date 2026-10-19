import { prisma } from "../config/prisma.js";
import {
  AVISO_DIAS,
  AVISO_DIAS_DEFAULT,
  AVISO_DIAS_VEHICULO,
  DOCUMENTOS_CHOFER,
  TAGLIANDO_INTERVALO_KM,
  TAGLIANDO_KM_RECORDATORIO,
  TAGLIANDO_KM_URGENTE,
} from "../config/vencimientos.js";
import { AppError } from "../utils/AppError.js";
import { romeDay } from "../utils/romeTime.js";
import { getSignedUrlForKey } from "./storage.service.js";

// Vista de Vencimientos: choferes con las fechas de sus documentos y vehiculos con seguro, revision y tagliando, cada fecha con su
// estado ya calculado (VENCIDO, PRONTO, VIGENTE o SIN_FECHA) para que la pantalla solo tenga que mostrarlo.
//  - OWNER: todo. RRHH: solo choferes (como en el resto de la app) y todos los vehiculos.
//  - ADMIN (Responsable): solo lo de su zona (User.responsableTipo = grupo del chofer o del vehiculo); sin zona asignada no ve nada.

const DAY_MS = 24 * 60 * 60 * 1000;
// Un Owner o Admin que maneja (cargo distinto de CHOFER) cuenta como chofer si hizo servicios en este tiempo.
const MANEJA_DIAS = 120;
const dayNumber = (day) => Math.floor(new Date(`${day}T00:00:00.000Z`).getTime() / DAY_MS);
const dateDay = (date) => date.toISOString().slice(0, 10);

const celda = (fecha, avisoDias, today) => {
  if (!fecha) return { fecha: null, dias: null, estado: "SIN_FECHA" };
  const day = dateDay(fecha);
  const dias = dayNumber(day) - dayNumber(today);
  return { fecha: day, dias, estado: dias < 0 ? "VENCIDO" : dias <= avisoDias ? "PRONTO" : "VIGENTE" };
};

// Km restantes para el proximo tagliando: urgente (o pasado) en rojo, recordatorio en naranja.
const tagliando = (vehicle) => {
  if (vehicle.kmUltimoMantenimiento == null || vehicle.kmActual == null) return { restante: null, usado: null, estado: "SIN_FECHA" };
  const usado = vehicle.kmActual - vehicle.kmUltimoMantenimiento;
  const restante = TAGLIANDO_INTERVALO_KM - usado;
  const estado = restante <= TAGLIANDO_KM_URGENTE ? "VENCIDO" : restante <= TAGLIANDO_KM_RECORDATORIO ? "PRONTO" : "VIGENTE";
  return { restante: Math.round(restante), usado: Math.round(usado), estado };
};

export const getVencimientosForActor = async (actor) => {
  const cargo = actor?.cargo;
  if (cargo !== "OWNER" && cargo !== "ADMIN" && cargo !== "RRHH") throw new AppError("No autorizado", 403);

  const today = romeDay();
  const zona = cargo === "ADMIN" ? actor.responsableTipo ?? null : undefined;
  const sinZona = cargo === "ADMIN" && !zona;
  const grupoWhere = zona ? { grupo: zona } : {};

  // Choferes = quienes tienen cargo CHOFER, mas los Owner/Admin que tambien manejan (con servicios hechos hace poco) o que ya
  // cargaron documentos. Recursos Humanos solo ve a los de cargo CHOFER, como en el resto de la app.
  let choferWhere = { cargo: "CHOFER" };
  if (cargo !== "RRHH" && !sinZona) {
    const manejan = await prisma.record.groupBy({
      by: ["driverId"],
      where: {
        driverId: { not: null },
        estado: { in: ["CONSEGNATO", "RITIRATO"] },
        fechaServicio: { gte: new Date(Date.now() - MANEJA_DIAS * DAY_MS) },
      },
    });
    choferWhere = {
      OR: [{ cargo: "CHOFER" }, { documentos: { some: {} } }, { id: { in: manejan.map((m) => m.driverId) } }],
    };
  }

  const [users, vehicles] = sinZona
    ? [[], []]
    : await Promise.all([
        prisma.user.findMany({
          where: { estado: "ACTIVO", ...choferWhere, ...grupoWhere },
          select: { id: true, nombre: true, apellido: true, grupo: true, fechaNacimiento: true, imagenPerfilKey: true },
          orderBy: [{ apellido: "asc" }, { nombre: "asc" }],
        }),
        prisma.vehiculo.findMany({
          where: { estado: { not: "FUERA_DE_SERVICIO" }, ...grupoWhere },
          select: {
            id: true,
            targa: true,
            modelo: true,
            grupo: true,
            poliza: true,
            rTecnica: true,
            kmUltimoMantenimiento: true,
            kmActual: true,
          },
          orderBy: { targa: "asc" },
        }),
      ]);

  const docs = users.length
    ? await prisma.documento.findMany({
        where: { usuarioId: { in: users.map((u) => u.id) }, tipoDocumento: { in: DOCUMENTOS_CHOFER } },
        select: { usuarioId: true, tipoDocumento: true, fechaScadenza: true },
      })
    : [];
  // Un chofer puede tener dos documentos del mismo tipo (el viejo y el renovado): vale el de fecha mas lejana.
  const fechaPor = new Map();
  for (const d of docs) {
    if (!d.fechaScadenza) continue;
    const key = `${d.usuarioId}|${d.tipoDocumento}`;
    const prev = fechaPor.get(key);
    if (!prev || d.fechaScadenza > prev) fechaPor.set(key, d.fechaScadenza);
  }

  const choferes = await Promise.all(
    users.map(async (u) => ({
      id: u.id,
      nombre: `${u.nombre} ${u.apellido}`.trim(),
      grupo: u.grupo,
      fechaNacimiento: dateDay(u.fechaNacimiento),
      imagenUrl: u.imagenPerfilKey ? await getSignedUrlForKey(u.imagenPerfilKey) : null,
      documentos: Object.fromEntries(
        DOCUMENTOS_CHOFER.map((tipo) => [tipo, celda(fechaPor.get(`${u.id}|${tipo}`), AVISO_DIAS[tipo] ?? AVISO_DIAS_DEFAULT, today)])
      ),
    }))
  );

  const vehiculos = vehicles.map((v) => ({
    id: v.id,
    targa: v.targa,
    modelo: v.modelo,
    grupo: v.grupo,
    seguro: celda(v.poliza, AVISO_DIAS_VEHICULO, today),
    revision: celda(v.rTecnica, AVISO_DIAS_VEHICULO, today),
    tagliando: tagliando(v),
  }));

  return {
    hoy: today,
    zona: zona ?? null,
    sinZona,
    documentos: DOCUMENTOS_CHOFER,
    // Cuantos dias antes avisa cada documento (para explicarlo en pantalla).
    avisoDias: Object.fromEntries(DOCUMENTOS_CHOFER.map((tipo) => [tipo, AVISO_DIAS[tipo] ?? AVISO_DIAS_DEFAULT])),
    avisoDiasVehiculo: AVISO_DIAS_VEHICULO,
    choferes,
    vehiculos,
  };
};
