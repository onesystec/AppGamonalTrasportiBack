import { handleGroupMessage, handleIncomingTelegramMessage } from "../services/telegramAssistant.service.js";
import { isAllowedChat, isGroupMember, isValidWebhookSecret } from "../services/telegram.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Webhook de Telegram (ver README) - Telegram espera un 200 rapido y sin importar el
// resultado, asi que esto siempre contesta 200 (nunca reintenta un mensaje por un
// error nuestro) y el trabajo real pasa antes de responder, no en background - los
// mensajes son cortos, entra comodo en el timeout del webhook.
//
// Los servicios se cargan por CHAT PRIVADO con el bot (cada persona tiene su propia conversacion, sin cruces); solo escriben por
// privado los miembros del grupo autorizado (TELEGRAM_ALLOWED_CHAT_ID). En el grupo el bot solo publica un resumen de lo que se
// carga y avisa a quien intente cargar ahi. Cualquier otro chat se ignora en silencio.
export const webhook = asyncHandler(async (req, res) => {
  const secret = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (!isValidWebhookSecret(secret)) {
    res.status(200).json({ success: true });
    return;
  }

  const message = req.body?.message;
  const callback = req.body?.callback_query;

  if (message) {
    const { chat, from, text } = message;
    if (chat?.id != null && typeof text === "string" && text.trim()) {
      if (chat.type === "private") {
        if (await isGroupMember(from?.id)) await handleIncomingTelegramMessage({ chatId: String(chat.id), from, text: text.trim() });
      } else if (isAllowedChat(chat.id)) {
        await handleGroupMessage({ chatId: String(chat.id), from, text: text.trim() });
      }
    }
  } else if (callback) {
    // Un boton apretado debajo de un mensaje del bot (solo existen en el chat privado).
    const chat = callback.message?.chat;
    if (chat?.id != null && chat.type === "private" && typeof callback.data === "string" && (await isGroupMember(callback.from?.id))) {
      await handleIncomingTelegramMessage({
        chatId: String(chat.id),
        from: callback.from,
        data: callback.data,
        messageId: callback.message.message_id,
        callbackId: callback.id,
      });
    }
  }

  res.status(200).json({ success: true });
});
