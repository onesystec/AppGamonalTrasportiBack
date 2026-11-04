import { prisma } from "../config/prisma.js";
import { deleteUserById, findUserById } from "../models/user.model.js";
import { AppError } from "../utils/AppError.js";
import { deleteObject } from "./storage.service.js";

// Fusion de dos fichas de la misma persona (el "duplicado" pasa todo a la ficha que se conserva): servicios, horas, combustible, multas, mancatos,
// permisos, busta paga, memorandums, documentos, avisos push, etc. Va todo en una sola transaccion: si algo falla no se mueve nada. El duplicado solo se
// elimina cuando no le queda ni una fila; si le queda algo (por ejemplo una busta paga del mismo mes que ya tiene la ficha que se conserva), se desactiva.

// [modelo de Prisma, campo que apunta al usuario, como se muestra en la vista previa (null = no se muestra)]
const MOVER = [
  ["record", "driverId", "Servicios"],
  ["locationPing", "driverId", null],
  ["mancatoPagamento", "driverId", "Mancatos"],
  ["mancatoPagamento", "createdById", null],
  ["multa", "driverId", "Multas"],
  ["multa", "createdById", null],
  ["registroCombustible", "driverId", "Cargas de combustible"],
  ["registroCombustible", "createdById", null],
  ["permiso", "driverId", "Permisos y dias libres"],
  ["permiso", "creadoPorId", null],
  ["permiso", "revisadoPorId", null],
  ["trabajoAdicional", "driverId", "Trabajos adicionales"],
  ["trabajoAdicional", "revisadoPorId", null],
  ["otroGasto", "driverId", "Otros gastos"],
  ["otroGasto", "revisadoPorId", null],
  ["solicitudServicio", "creadoPorId", null],
  ["solicitudServicio", "revisadoPorId", null],
  ["mantenimientoVehiculo", "usuarioId", null],
  ["documento", "usuarioId", "Documentos"],
  ["pushToken", "userId", null],
  ["speedingEvent", "driverId", null],
  ["paradaVehiculo", "driverId", null],
  ["memorandum", "emisorId", "Memorandums emitidos"],
  ["memorandumAcceso", "usuarioId", null],
  ["bustaPagaAcceso", "usuarioId", null],
  ["bustaPaga", "subidaPorId", null],
];

const validar = async (actor, destinoId, origenId) => {
  if (destinoId === origenId) throw new AppError("Elegi dos fichas distintas", 400);
  if (actor.id === origenId) throw new AppError("No puedes fusionar tu propia cuenta como duplicado", 400);
  const [destino, origen] = await Promise.all([findUserById(destinoId), findUserById(origenId)]);
  if (!destino || !origen) throw new AppError("Usuario no encontrado", 404);
  if (origen.cargo !== "CHOFER") throw new AppError("El duplicado tiene que ser un chofer", 400);
  if (destino.cargo === "CLIENTE") throw new AppError("La ficha que se conserva no puede ser un usuario cliente", 400);
  return { destino, origen };
};

// Cuanto tiene el duplicado en cada tabla (lo que se mueve y lo que puede chocar con la ficha que se conserva).
const contar = async (db, origenId, destinoId) => {
  const porEtiqueta = {};
  let total = 0;
  for (const [model, field, label] of MOVER) {
    const n = await db[model].count({ where: { [field]: origenId } });
    total += n;
    if (label && n > 0) porEtiqueta[label] = (porEtiqueta[label] ?? 0) + n;
  }
  const bustas = await db.bustaPaga.findMany({ where: { choferId: origenId }, select: { id: true, anio: true, mes: true } });
  const bustasDestino = new Set((await db.bustaPaga.findMany({ where: { choferId: destinoId }, select: { anio: true, mes: true } })).map((b) => `${b.anio}-${b.mes}`));
  const bustasChocan = bustas.filter((b) => bustasDestino.has(`${b.anio}-${b.mes}`));
  const memos = await db.memorandumDestinatario.count({ where: { userId: origenId } });
  const velocidades = await db.velocidadPagoChofer.count({ where: { driverId: origenId } });
  if (bustas.length) porEtiqueta["Busta paga"] = bustas.length;
  if (memos) porEtiqueta["Memorandums recibidos"] = memos;
  if (velocidades) porEtiqueta["Velocidades de pago"] = velocidades;
  return { porEtiqueta, total: total + bustas.length + memos + velocidades, bustasChocan };
};

export const previewFusion = async (actor, destinoId, origenId) => {
  const { destino, origen } = await validar(actor, destinoId, origenId);
  const { porEtiqueta, bustasChocan } = await contar(prisma, origenId, destinoId);
  return {
    destino: { id: destino.id, nombre: destino.nombre, apellido: destino.apellido, correoElectronico: destino.correoElectronico },
    origen: { id: origen.id, nombre: origen.nombre, apellido: origen.apellido, correoElectronico: origen.correoElectronico },
    mover: porEtiqueta,
    bustasPagaEnConflicto: bustasChocan.length,
  };
};

export const fusionarChoferes = async (actor, destinoId, origenId) => {
  const { destino, origen } = await validar(actor, destinoId, origenId);

  const resultado = await prisma.$transaction(
    async (tx) => {
      const antes = await contar(tx, origenId, destinoId);

      for (const [model, field] of MOVER) {
        await tx[model].updateMany({ where: { [field]: origenId }, data: { [field]: destinoId } });
      }

      // Busta paga: una por chofer y mes. Las que no chocan pasan; si la ficha que se conserva ya tiene la del mismo mes, esa queda con el duplicado.
      const chocan = new Set(antes.bustasChocan.map((b) => b.id));
      const bustas = await tx.bustaPaga.findMany({ where: { choferId: origenId }, select: { id: true } });
      for (const b of bustas) {
        if (!chocan.has(b.id)) await tx.bustaPaga.update({ where: { id: b.id }, data: { choferId: destinoId } });
      }

      // Memorandums recibidos: si los dos eran destinatarios del mismo, se conserva la firma (la del duplicado si la ficha que se conserva no firmo).
      const recibidos = await tx.memorandumDestinatario.findMany({ where: { userId: origenId } });
      for (const r of recibidos) {
        const propio = await tx.memorandumDestinatario.findUnique({ where: { memorandumId_userId: { memorandumId: r.memorandumId, userId: destinoId } } });
        if (!propio) {
          await tx.memorandumDestinatario.update({ where: { id: r.id }, data: { userId: destinoId } });
          continue;
        }
        if (r.firmadaAt && !propio.firmadaAt) {
          await tx.memorandumDestinatario.update({
            where: { id: propio.id },
            data: { firmadaAt: r.firmadaAt, firmaKey: r.firmaKey, firmaIp: r.firmaIp, firmaDispositivo: r.firmaDispositivo },
          });
          await tx.memorandumDestinatario.update({ where: { id: r.id }, data: { firmaKey: null } });
        }
        await tx.memorandumDestinatario.delete({ where: { id: r.id } });
      }

      // Velocidad de pago (un valor por mes): si los dos tienen el mismo mes, manda la de la ficha que se conserva.
      const velocidades = await tx.velocidadPagoChofer.findMany({ where: { driverId: origenId } });
      for (const v of velocidades) {
        const propia = await tx.velocidadPagoChofer.findUnique({ where: { driverId_mes: { driverId: destinoId, mes: v.mes } } });
        if (propia) await tx.velocidadPagoChofer.delete({ where: { id: v.id } });
        else await tx.velocidadPagoChofer.update({ where: { id: v.id }, data: { driverId: destinoId } });
      }

      // La foto de perfil: si la ficha que se conserva no tiene, adopta la del duplicado.
      const fotos = await tx.user.findMany({ where: { id: { in: [origenId, destinoId] } }, select: { id: true, imagenPerfilKey: true } });
      const fotoOrigen = fotos.find((u) => u.id === origenId)?.imagenPerfilKey ?? null;
      const fotoDestino = fotos.find((u) => u.id === destinoId)?.imagenPerfilKey ?? null;
      let fotoSobrante = null;
      if (fotoOrigen && !fotoDestino) {
        await tx.user.update({ where: { id: origenId }, data: { imagenPerfilKey: null } });
        await tx.user.update({ where: { id: destinoId }, data: { imagenPerfilKey: fotoOrigen } });
      } else if (fotoOrigen) {
        fotoSobrante = fotoOrigen;
      }

      // Al duplicado solo se lo elimina si no le quedo nada (lo que se borra en cascada no se puede perder).
      const despues = await contar(tx, origenId, destinoId);
      const sinNada = despues.total === 0;
      return { sinNada, fotoSobrante, movido: antes.porEtiqueta, quedaron: despues.porEtiqueta, bustasPagaEnConflicto: despues.bustasChocan.length };
    },
    { timeout: 120000, maxWait: 20000 }
  );

  if (resultado.sinNada) {
    await deleteUserById(origenId);
    if (resultado.fotoSobrante) await deleteObject(resultado.fotoSobrante).catch(() => {});
  } else {
    await prisma.user.update({ where: { id: origenId }, data: { estado: "INACTIVO" } });
  }

  console.log(`[fusion] ${origen.nombre} ${origen.apellido} (${origenId}) -> ${destino.nombre} ${destino.apellido} (${destinoId}) por ${actor.id}: ${JSON.stringify(resultado.movido)}`);
  return {
    destino: { id: destino.id, nombre: destino.nombre, apellido: destino.apellido },
    origenEliminado: resultado.sinNada,
    movido: resultado.movido,
    quedaronEnElDuplicado: resultado.quedaron,
  };
};
