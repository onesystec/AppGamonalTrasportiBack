import { prisma } from "../config/prisma.js";
import { findClients } from "../models/client.model.js";
import { updateRecordById } from "../models/record.model.js";
import { deleteDraft, findDraftByChat, saveDraftState } from "../models/telegramDraft.model.js";
import { findAllUsers } from "../models/user.model.js";
import { findVehicles } from "../models/vehicle.model.js";
import { romeDay } from "../utils/romeTime.js";
import { createRecord } from "./record.service.js";
import { calculateRoute } from "./routing.service.js";
import { answerTelegramCallback, clearTelegramButtons, sendTelegramMessage } from "./telegram.service.js";
import { aiExtractFields } from "./telegramAiExtractor.service.js";
import { TIPOS, buildRecordInput, handleMessage } from "./telegramEngine.js";
import { checkConflicts, estimateRoute, listToday, rememberCreated, resolveTelegramActor, undoLast } from "./telegramExtras.service.js";

// Un borrador sin tocar durante tanto tiempo se descarta: nadie espera retomar un servicio de ayer.
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;
const REFS_TTL_MS = 60 * 1000;
const UNDO_BUTTONS = [[{ text: "↩️ Deshacer", data: "u" }]];

let refsCache = null;
const loadRefs = async () => {
  if (refsCache && Date.now() - refsCache.at < REFS_TTL_MS) return refsCache.value;
  // "Chofer" es cualquiera que maneja: choferes, Responsables y Admin (igual que en el calendario del app).
  const [users, vehicles, clients] = await Promise.all([findAllUsers(), findVehicles(), findClients()]);
  // Los vehiculos de Farmacia (area o grupo) no se usan en el bot.
  const value = {
    drivers: users.filter((u) => u.estado === "ACTIVO" && ["CHOFER", "ADMIN", "OWNER"].includes(u.cargo)),
    vehicles: vehicles.filter((v) => v.area !== "FARMACIA" && v.grupo !== "FARMACIA"),
    clients,
  };
  refsCache = { at: Date.now(), value };
  return value;
};

const readState = (draft) => {
  if (!draft || draft.pendingPriceRecordId) return null;
  if (Date.now() - new Date(draft.updatedAt).getTime() > DRAFT_TTL_MS) return null;
  const state = draft.messages;
  if (!state || Array.isArray(state) || state.v !== 2) return null;
  return state.batch || TIPOS[state.tipo] ? state : null;
};

// Lo que dice un boton, como si la persona lo hubiera escrito.
const callbackToText = (data, refs) => {
  if (data === "y") return "sí";
  if (data === "n") return "cancelar";
  if (data === "e") return "editar";
  if (data === "u") return "/deshacer";
  if (data === "r") return "sí";
  const [kind, value] = [data.slice(0, 1), data.slice(2)];
  if (kind === "t") return TIPOS[value] ? value : null;
  if (kind === "d") {
    const d = refs.drivers.find((x) => x.id === value);
    return d ? `${d.nombre} ${d.apellido}` : null;
  }
  if (kind === "c") return refs.clients.find((x) => x.id === value)?.nombre ?? null;
  if (kind === "v") return refs.vehicles.find((x) => x.id === value)?.targa ?? null;
  return null;
};

// Km del circuito completo (salida -> paradas -> vuelta a la salida), para Extras Piazza y Otros. La ruta salida -> paradas
// ya la calculo createRecord; falta el tramo de vuelta. Aproximado: las paradas son ciudades.
const circuitKm = async (record) => {
  const lastStop = record.stops?.at(-1);
  const salida = record.salida;
  if (!lastStop || salida?.lat == null || record.ruta?.distanciaKm == null) return null;
  const back = await calculateRoute([{ lat: lastStop.lat, lng: lastStop.lng }, { lat: salida.lat, lng: salida.lng }]);
  if (!back) return null;
  return Math.round((record.ruta.distanciaKm + back.distanciaKm) * 10) / 10;
};

// Crea un servicio. Devuelve { id, text } (text: lo que se le cuenta a quien lo pidio).
const createFromState = async (state, who) => {
  const tipo = TIPOS[state.tipo];
  const quien = `Cargado por Telegram${who.name ? ` por ${who.name}` : ""}.`;
  const record = await createRecord({ ...buildRecordInput(state), comentarios: quien }, { actor: who.actor });

  let km = state.km > 0 ? state.km : null;
  let aprox = false;
  if (km == null && !tipo.kmCliente) {
    km = await circuitKm(record);
    aprox = km != null;
    if (km != null) {
      await updateRecordById(record.id, {
        kilometros: km,
        comentarios: `${quien} Km calculados por el sistema (circuito completo, aproximado por ciudades).`,
      });
    }
  }

  const lines = [`Servicio cargado ✅ (código ${record.codigo}) · ${tipo.label}`];
  if (tipo.kmCliente) lines.push(`KM del cliente (solo ida): ${km}. El app los cuenta ×2 = ${km * 2}.`);
  else if (km != null) lines.push(`KM del circuito completo${aprox ? " (aprox., calculado por ciudades)" : ""}: ${km}.`);
  else lines.push("No pude calcular los km solos: cárgalos a mano en el app.");
  if (state.tipo === "PM" || state.tipo === "PR") {
    lines.push(`Retiro ${state.horaSalida} · ${state.etaManual ? "ETA" : "llegada estimada al último punto"} ${state.hora}.`);
  } else if (state.horaSalida) {
    lines.push(`Retiro ${state.horaSalida} · ETA ${state.hora}. Pasará solo a «En camino» pasado el retiro.`);
  }
  return { id: record.id, text: lines.join("\n") };
};

// Punto de entrada del webhook (ver telegram.controller.js). Llega un mensaje de texto o un boton apretado (data).
export const handleIncomingTelegramMessage = async ({ chatId, from, text, data, messageId, callbackId }) => {
  if (callbackId) await answerTelegramCallback(callbackId);

  const who = await resolveTelegramActor(from);
  if (!who.ok) {
    await sendTelegramMessage(chatId, who.reply);
    return;
  }

  // Cada persona tiene su propio borrador, aunque comparta el grupo con otras.
  const userKey = String(from?.id ?? chatId);
  const draftKey = `${chatId}:${userKey}`;
  const refs = await loadRefs();

  let input = text;
  if (data) {
    if (messageId) await clearTelegramButtons(chatId, messageId);
    input = callbackToText(data, refs);
    if (input == null) return;
  }

  if (/^\/hoy\b/i.test(input)) {
    await sendTelegramMessage(chatId, await listToday(who, romeDay()));
    return;
  }
  if (/^\/(deshacer|undo)\b/i.test(input)) {
    await sendTelegramMessage(chatId, await undoLast(userKey, who));
    return;
  }

  const prevState = readState(await findDraftByChat(draftKey));
  const ctx = {
    refs,
    today: romeDay(),
    aiExtract: ({ text: body, state }) => aiExtractFields({ text: body, state, refs, today: romeDay() }),
    checkConflicts: (state) => checkConflicts(state, refs),
    estimateRoute,
  };

  let result;
  try {
    result = await handleMessage(prevState, input, ctx);
  } catch (err) {
    console.error("[telegram] Error interpretando el mensaje:", err);
    await sendTelegramMessage(chatId, "Tuve un problema entendiendo el mensaje, intenta de nuevo.");
    return;
  }

  if (result.action === "cancel") {
    await deleteDraft(draftKey);
    await sendTelegramMessage(chatId, result.reply);
    return;
  }

  if (result.action !== "create") {
    if (result.state) await saveDraftState(draftKey, result.state);
    await sendTelegramMessage(chatId, result.reply, { buttons: result.buttons });
    return;
  }

  // Varios servicios (lineas de un mismo mensaje): se cargan uno por uno y se cuenta como le fue a cada uno.
  if (result.state.batch) {
    const ids = [];
    const lines = [];
    for (const [i, state] of result.state.batch.entries()) {
      try {
        const out = await createFromState(state, who);
        ids.push(out.id);
        lines.push(`${i + 1}) ${out.text}`);
      } catch (err) {
        console.error("[telegram] No se pudo crear un servicio del lote:", err.message);
        lines.push(`${i + 1}) No se pudo cargar: ${err.message}`);
      }
    }
    await deleteDraft(draftKey);
    if (ids.length) await rememberCreated(userKey, ids);
    await sendTelegramMessage(chatId, lines.join("\n\n"), { buttons: ids.length ? UNDO_BUTTONS : undefined });
    return;
  }

  try {
    const out = await createFromState(result.state, who);
    await deleteDraft(draftKey);
    await rememberCreated(userKey, [out.id]);
    await sendTelegramMessage(chatId, out.text, { buttons: UNDO_BUTTONS });
  } catch (err) {
    console.error("[telegram] No se pudo crear el servicio:", err.message);
    // Se conserva el borrador para corregir el dato que fallo (ej. una ciudad que no se ubica) sin repetir todo.
    await saveDraftState(draftKey, result.state);
    await sendTelegramMessage(
      chatId,
      `No pude cargar el servicio: ${err.message}\nCorrige el dato (ej: ruta: Lodi - Piacenza) y responde sí, o escribe cancelar.`
    );
  }
};
