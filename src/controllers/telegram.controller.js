import { handleIncomingTelegramMessage } from "../services/telegramAssistant.service.js";
import { isAllowedChat, isValidWebhookSecret } from "../services/telegram.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Webhook de Telegram (ver README) - Telegram espera un 200 rapido y sin importar el
// resultado, asi que esto siempre contesta 200 (nunca reintenta un mensaje por un
// error nuestro) y el trabajo real pasa antes de responder, no en background - los
// mensajes son cortos, entra comodo en el timeout del webhook.
export const webhook = asyncHandler(async (req, res) => {
  const secret = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (!isValidWebhookSecret(secret)) {
    res.status(200).json({ success: true });
    return;
  }

  const message = req.body?.message;
  const callback = req.body?.callback_query;

  if (message) {
    const chatId = message.chat?.id;
    const text = message.text;
    if (chatId != null && isAllowedChat(chatId) && typeof text === "string" && text.trim()) {
      await handleIncomingTelegramMessage({ chatId: String(chatId), from: message.from, text: text.trim() });
    }
  } else if (callback) {
    // Un boton apretado debajo de un mensaje del bot.
    const chatId = callback.message?.chat?.id;
    if (chatId != null && isAllowedChat(chatId) && typeof callback.data === "string") {
      await handleIncomingTelegramMessage({
        chatId: String(chatId),
        from: callback.from,
        data: callback.data,
        messageId: callback.message.message_id,
        callbackId: callback.id,
      });
    }
  }

  res.status(200).json({ success: true });
});
