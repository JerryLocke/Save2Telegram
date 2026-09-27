import { AppError, Err } from './errors.js';
import { checkCancelled, updateJob } from './jobs.js';
import { forwardTelegramMessages, validateTelegramChat } from './telegram.js';

export function normalizeTelegramSource(source) {
  const chatId = String(source?.chatId || '').trim();
  const chatUsername = String(source?.chatUsername || '').trim();
  const ids = source?.messageIds;
  if (!/^-[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || Number(chatId) >= -1000000000000 ||
      (chatUsername && !/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(chatUsername)) ||
      !Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some(id => !Number.isInteger(id) || id <= 0 || id > 0x7fffffff)) {
    throw new AppError(Err.VALIDATION_FAILED, 'Invalid Telegram source chat or message IDs.');
  }
  return { chatId, messageIds: [...new Set(ids)].sort((a, b) => a - b), ...(chatUsername ? { chatUsername } : {}), ...(source.protectedContent === true ? { protectedContent: true } : {}) };
}

/** Use the configured Bot API Server's Telegram session; no media download or upload. */
export async function forwardTelegramSource(payload, telegram, job = null) {
  const source = normalizeTelegramSource(payload.telegramSource);
  checkCancelled(job);
  const chat = await validateTelegramChat(telegram.botToken, source.chatUsername || source.chatId, job?.abortController?.signal);
  // A username can change or the Web UI may have navigated during collection.
  if (String(chat.id) !== source.chatId) {
    throw new AppError(Err.VALIDATION_FAILED, 'The source username no longer matches the selected chat. Reopen the source chat and try again.');
  }
  // TDLib permits bots to copy protected messages they can access, although
  // forwarding those messages with their original attribution is disallowed.
  // See MessagesManager::can_forward_message(..., is_copy) in tdlib/td.
  const asCopy = Boolean(source.protectedContent || chat.has_protected_content);
  checkCancelled(job);
  updateJob(job, { phase: 'forwarding', phaseProgress: 0, progress: 0, bytesLoaded: 0, bytesTotal: 0 });
  const result = await forwardTelegramMessages(telegram.botToken, telegram.chatId, source, job?.abortController?.signal, asCopy);
  const count = Array.isArray(result) ? result.length : 0;
  // Telegram silently skips unavailable messages. Never mark a partial album as
  // successful or automatically retry it, which could duplicate the sent items.
  if (count !== source.messageIds.length) {
    throw new AppError(Err.TELEGRAM_API_ERROR,
      `Telegram ${asCopy ? 'copied' : 'forwarded'} ${count}/${source.messageIds.length} messages. Some are unavailable or unsupported. Check the destination before retrying; a retry may duplicate messages already sent.`);
  }
  return result;
}
