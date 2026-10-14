import { prisma } from "../config/prisma.js";

// Un borrador por chat. El estado de la conversacion (ver telegramEngine.js, newState) vive en la columna JSON "messages":
// se llama asi por el diseno anterior (historial para Claude) y se reutiliza para no tocar la base.
export const findDraftByChat = (chatId) => prisma.telegramDraft.findUnique({ where: { chatId } });

export const saveDraftState = (chatId, state) =>
  prisma.telegramDraft.upsert({
    where: { chatId },
    update: { messages: state, pendingPriceRecordId: null },
    create: { chatId, messages: state },
  });

export const deleteDraft = (chatId) =>
  prisma.telegramDraft.delete({ where: { chatId } }).catch(() => null);
