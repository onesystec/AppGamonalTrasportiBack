import { env } from "../config/env.js";

const TELEGRAM_API = "https://api.telegram.org";

// Llamada a la API de Telegram. Best-effort a proposito, igual que el resto de las integraciones externas de la app: si
// Telegram esta caido no tiene sentido tirar un 500, ya perdimos el mensaje de todas formas.
const callTelegram = async (method, body) => {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Telegram ${method} fallo:`, res.status, text);
      return null;
    }
    return (await res.json()).result ?? null;
  } catch (err) {
    console.error(`Telegram ${method} fallo:`, err.message);
    return null;
  }
};

// Le contesta al chat (ver telegramAssistant.service.js, que arma el texto). buttons: filas de { text, data } que salen como
// teclado debajo del mensaje; al apretar uno, Telegram manda "data" de vuelta (callback_query).
export const sendTelegramMessage = (chatId, text, { buttons } = {}) =>
  callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(buttons?.length
      ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } }
      : {}),
  });

// Quita el reloj de "cargando" del boton apretado.
export const answerTelegramCallback = (callbackId, text) =>
  callTelegram("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });

// Saca los botones de un mensaje ya usado, para que no se aprieten dos veces.
export const clearTelegramButtons = (chatId, messageId) =>
  callTelegram("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });

// Quien puede escribirle al bot por privado: solo los miembros del grupo autorizado (TELEGRAM_ALLOWED_CHAT_ID). Se le pregunta a
// Telegram y se recuerda un rato; si no se puede comprobar, no se deja pasar a nadie.
const MEMBER_OK_MS = 5 * 60 * 1000;
const MEMBER_NO_MS = 60 * 1000;
const memberCache = new Map();
export const isGroupMember = async (userId) => {
  if (!env.TELEGRAM_ALLOWED_CHAT_ID || userId == null) return false;
  const hit = memberCache.get(userId);
  if (hit && Date.now() - hit.at < (hit.ok ? MEMBER_OK_MS : MEMBER_NO_MS)) return hit.ok;
  const member = await callTelegram("getChatMember", { chat_id: env.TELEGRAM_ALLOWED_CHAT_ID, user_id: userId });
  const ok = Boolean(member && (["creator", "administrator", "member"].includes(member.status) || (member.status === "restricted" && member.is_member)));
  memberCache.set(userId, { ok, at: Date.now() });
  return ok;
};

// @usuario del bot, para decirle a la gente donde escribirle.
let botUsername = null;
export const getBotUsername = async () => {
  botUsername ??= (await callTelegram("getMe", {}))?.username ?? null;
  return botUsername;
};

// Publica un aviso en el grupo autorizado.
export const notifyGroup = (text) => (env.TELEGRAM_ALLOWED_CHAT_ID ? sendTelegramMessage(env.TELEGRAM_ALLOWED_CHAT_ID, text) : null);

// El header que Telegram manda en cada request al webhook (configurado al registrar
// la URL con /setWebhook, ver README) - si no coincide, no es un mensaje real de
// Telegram y se descarta sin procesar nada.
export const isValidWebhookSecret = (headerValue) => {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return false;
  return headerValue === env.TELEGRAM_WEBHOOK_SECRET;
};

// Solo el chat configurado puede cargar servicios - cualquier otro (alguien que le
// escriba al bot desde afuera) se ignora en silencio, ni siquiera se le contesta para
// no confirmarle que el bot existe/está activo.
export const isAllowedChat = (chatId) =>
  Boolean(env.TELEGRAM_ALLOWED_CHAT_ID) && String(chatId) === env.TELEGRAM_ALLOWED_CHAT_ID;
