/** Bot API IDs only: DOM-specific IDs are converted in the content script. */
function normalizeTelegramSource(source) {
  const chatId = String(source?.chatId || '').trim();
  const chatUsername = String(source?.chatUsername || '').trim();
  const ids = source?.messageIds;
  if (!/^-[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || Number(chatId) >= -1000000000000 ||
      (chatUsername && !/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(chatUsername)) ||
      !Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some(id => !Number.isInteger(id) || id <= 0 || id > 0x7fffffff)) {
    throw new Error(__t('bg_telegramInvalidSource'));
  }
  return { chatId, messageIds: [...new Set(ids)].sort((a, b) => a - b), ...(chatUsername ? { chatUsername } : {}), ...(source.protectedContent === true ? { protectedContent: true } : {}) };
}

async function forwardTelegramSource(payload, config, queueItemId, signal) {
  const source = normalizeTelegramSource(payload.telegramSource);
  const chat = await validateTelegramChat(config.botToken, source.chatUsername || source.chatId, signal);
  if (String(chat.id) !== source.chatId) throw new Error(__t('bg_telegramSourceChanged'));
  const method = source.protectedContent || chat.has_protected_content ? 'copyMessages' : 'forwardMessages';
  await markQueueItem(queueItemId, { phase: 'forwarding', progress: 0, phaseProgress: 0 });
  await appendQueueDebugLog(queueItemId, `${method}: ${source.messageIds.length} Telegram message(s) without downloading`);
  const result = await callTelegram(config.botToken, method, {
    chat_id: config.chatId, from_chat_id: source.chatId, message_ids: source.messageIds
  }, signal);
  const count = Array.isArray(result) ? result.length : 0;
  if (count !== source.messageIds.length) {
    throw new Error(__t('bg_telegramPartialForward', [count, source.messageIds.length]));
  }
  return result;
}
