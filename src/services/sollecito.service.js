import { randomUUID } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { deleteObject, getSignedUrlForKey, uploadObject } from "./storage.service.js";
import { compressImage } from "../utils/imageProcessor.js";
import { AppError } from "../utils/AppError.js";

// Solleciti: cartas de la autopista que reclaman mancati pagamenti. Solo la oficina (OWNER/ADMIN).

const dayToDate = (day) => new Date(`${day}T00:00:00.000Z`);
const toDay = (date) => (date ? date.toISOString().slice(0, 10) : null);

const processFile = async (file) => {
  if (file.mimetype === "application/pdf") {
    return { buffer: file.buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  const buffer = await compressImage(file.buffer);
  return { buffer, mimeType: "image/webp", ext: "webp" };
};

const uploadAttachment = async (id, kind, file) => {
  const { buffer, mimeType, ext } = await processFile(file);
  const key = `sollecito/${id}/${kind}-${Date.now()}-${randomUUID()}.${ext}`;
  await uploadObject(key, buffer, mimeType);
  return key;
};

const attachment = async (key) => (key ? { url: await getSignedUrlForKey(key), esPdf: key.endsWith(".pdf") } : null);

// Los mancatos de la app que reclama este sollecito (por su numero), con su estado de pago.
const findMancatosByNumero = async (numeros) => {
  if (!numeros.length) return new Map();
  const rows = await prisma.mancatoPagamento.findMany({
    where: { numero: { in: numeros } },
    select: { id: true, numero: true, pagado: true, pagadoAt: true, observado: true, fecha: true, costo: true, targa: true },
  });
  return new Map(rows.map((m) => [m.numero, m]));
};

const toResponse = async (s, mancatosByNumero) => {
  const [archivo, comprobante] = await Promise.all([attachment(s.archivoKey), attachment(s.comprobanteKey)]);
  const mancatos = s.numerosMancato.map((numero) => {
    const m = mancatosByNumero.get(numero);
    return m
      ? {
          numero,
          id: m.id,
          enApp: true,
          pagado: m.pagado,
          pagadoAt: m.pagadoAt,
          observado: m.observado,
          fecha: toDay(m.fecha),
          costo: Number(m.costo),
          targa: m.targa,
        }
      : { numero, enApp: false };
  });
  return {
    id: s.id,
    emisor: s.emisor,
    numeroAtto: s.numeroAtto,
    fechaCarta: toDay(s.fechaCarta),
    fechaTransito: toDay(s.fechaTransito),
    fechaLimitePago: toDay(s.fechaLimitePago),
    targa: s.targa,
    // Targas a la vista: la de la carta y las de los mancatos de la app que reclama.
    // ("SIN TARGA" es un relleno de algunos mancatos: no cuenta como targa).
    targas: [
      ...new Set(
        [s.targa, ...mancatos.filter((m) => m.enApp).map((m) => m.targa)].filter((t) => t && !/^SIN/i.test(t))
      ),
    ],
    numerosMancato: s.numerosMancato,
    mancatos,
    importe: s.importe === null ? null : Number(s.importe),
    sitioPago: s.sitioPago,
    estado: s.estado,
    pagadoAt: s.pagadoAt,
    comentarios: s.comentarios,
    archivo,
    comprobante,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
};

const toResponses = async (rows) => {
  const mancatosByNumero = await findMancatosByNumero([...new Set(rows.flatMap((s) => s.numerosMancato))]);
  return Promise.all(rows.map((s) => toResponse(s, mancatosByNumero)));
};

const buildWhere = (query) => {
  const and = [];
  if (query.estado) and.push({ estado: query.estado });
  if (query.from) and.push({ fechaCarta: { gte: dayToDate(query.from) } });
  if (query.to) and.push({ fechaCarta: { lte: dayToDate(query.to) } });
  if (query.q) {
    const q = query.q;
    and.push({
      OR: [
        { numeroAtto: { contains: q, mode: "insensitive" } },
        { emisor: { contains: q, mode: "insensitive" } },
        { targa: { contains: q.replace(/\s+/g, "").toUpperCase() } },
        { comentarios: { contains: q, mode: "insensitive" } },
        { numerosMancato: { has: q } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
};

const dataFrom = (fields) => {
  const data = {};
  for (const key of ["emisor", "numeroAtto", "targa", "numerosMancato", "importe", "sitioPago", "comentarios"]) {
    if (key in fields && fields[key] !== undefined) data[key] = fields[key];
  }
  if (fields.fechaCarta !== undefined) data.fechaCarta = fields.fechaCarta ? dayToDate(fields.fechaCarta) : null;
  if (fields.fechaTransito !== undefined) data.fechaTransito = fields.fechaTransito ? dayToDate(fields.fechaTransito) : null;
  if (fields.fechaLimitePago !== undefined) {
    data.fechaLimitePago = fields.fechaLimitePago ? dayToDate(fields.fechaLimitePago) : null;
  }
  return data;
};

const assertAttoLibre = async (numeroAtto, exceptId) => {
  const existing = await prisma.sollecito.findUnique({ where: { numeroAtto } });
  if (existing && existing.id !== exceptId) {
    throw new AppError(`Ya existe un sollecito con el atto ${numeroAtto}`, 409);
  }
};

export const listSolleciti = async (query) => {
  const rows = await prisma.sollecito.findMany({
    where: buildWhere(query),
    orderBy: [{ fechaCarta: "desc" }, { createdAt: "desc" }],
  });
  const items = await toResponses(rows);
  const resumen = { POR_PAGAR: { count: 0, total: 0 }, PAGADO: { count: 0, total: 0 }, NO_CORRESPONDE: { count: 0, total: 0 } };
  for (const s of items) {
    resumen[s.estado].count += 1;
    resumen[s.estado].total = Math.round((resumen[s.estado].total + (s.importe ?? 0)) * 100) / 100;
  }
  return { items, resumen };
};

export const getSollecito = async (id) => {
  const s = await prisma.sollecito.findUnique({ where: { id } });
  if (!s) throw new AppError("Sollecito no encontrado", 404);
  const [item] = await toResponses([s]);
  return item;
};

export const createSollecito = async (actor, fields, files = {}) => {
  await assertAttoLibre(fields.numeroAtto);
  const id = randomUUID();
  const uploaded = [];
  try {
    const archivoKey = files.archivo?.[0] ? await uploadAttachment(id, "sollecito", files.archivo[0]) : null;
    if (archivoKey) uploaded.push(archivoKey);
    const comprobanteKey = files.comprobante?.[0] ? await uploadAttachment(id, "comprobante", files.comprobante[0]) : null;
    if (comprobanteKey) uploaded.push(comprobanteKey);
    const estado = fields.estado ?? (comprobanteKey ? "PAGADO" : "POR_PAGAR");
    const created = await prisma.sollecito.create({
      data: {
        id,
        ...dataFrom(fields),
        archivoKey,
        comprobanteKey,
        estado,
        pagadoAt: estado === "PAGADO" ? new Date() : null,
        createdById: actor.id,
      },
    });
    const [item] = await toResponses([created]);
    return item;
  } catch (err) {
    await Promise.allSettled(uploaded.map((key) => deleteObject(key)));
    throw err;
  }
};

export const updateSollecito = async (id, fields, files = {}) => {
  const current = await prisma.sollecito.findUnique({ where: { id } });
  if (!current) throw new AppError("Sollecito no encontrado", 404);
  if (fields.numeroAtto && fields.numeroAtto !== current.numeroAtto) await assertAttoLibre(fields.numeroAtto, id);

  const data = dataFrom(fields);
  const uploaded = [];
  const oldKeys = [];
  try {
    if (files.archivo?.[0]) {
      data.archivoKey = await uploadAttachment(id, "sollecito", files.archivo[0]);
      uploaded.push(data.archivoKey);
      if (current.archivoKey) oldKeys.push(current.archivoKey);
    }
    if (files.comprobante?.[0]) {
      data.comprobanteKey = await uploadAttachment(id, "comprobante", files.comprobante[0]);
      uploaded.push(data.comprobanteKey);
      if (current.comprobanteKey) oldKeys.push(current.comprobanteKey);
    }
    // Subir un comprobante sin decir el estado lo marca como pagado.
    const estado = fields.estado ?? (data.comprobanteKey ? "PAGADO" : undefined);
    if (estado && estado !== current.estado) {
      data.estado = estado;
      data.pagadoAt = estado === "PAGADO" ? new Date() : null;
    }
    const updated = await prisma.sollecito.update({ where: { id }, data });
    await Promise.allSettled(oldKeys.map((key) => deleteObject(key)));
    const [item] = await toResponses([updated]);
    return item;
  } catch (err) {
    await Promise.allSettled(uploaded.map((key) => deleteObject(key)));
    throw err;
  }
};

export const deleteSollecito = async (id) => {
  const current = await prisma.sollecito.findUnique({ where: { id } });
  if (!current) throw new AppError("Sollecito no encontrado", 404);
  await prisma.sollecito.delete({ where: { id } });
  await Promise.allSettled([current.archivoKey, current.comprobanteKey].filter(Boolean).map((key) => deleteObject(key)));
};
