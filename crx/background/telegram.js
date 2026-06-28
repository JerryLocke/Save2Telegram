async function sendTelegramPhoto(botToken, chatId, photo, caption, queueItemId = "", signal = null) {
  await markTelegramUploadProgress(queueItemId);
  return callTelegram(botToken, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML"
  }, signal);
}
async function sendTelegramPhotoFile(botToken, chatId, photoFile, caption, queueItemId = "", signal = null) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("photo", photoFile.blob, photoFile.filename);
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }
  await appendQueueDebugLog(queueItemId, `Uploading Telegram photo: ${photoFile.filename || "twitter-photo.jpg"}`);
  return callTelegramMultipartLogged(botToken, "sendPhoto", form, queueItemId, signal);
}
/** Send a video via Telegram API (URL reference). */
async function sendTelegramVideo(botToken, chatId, video, caption, signal = null) {
  return callTelegram(botToken, "sendVideo", {
    chat_id: chatId,
    video,
    caption,
    parse_mode: "HTML",
    supports_streaming: true
  }, signal);
}
/** Upload and send a video Blob to Telegram. */
async function sendTelegramVideoFile(botToken, chatId, videoFile, caption, queueItemId = "", signal = null) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("video", videoFile.blob, videoFile.filename);
  form.set("supports_streaming", "true");
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }
  await appendQueueDebugLog(queueItemId, `Uploading Telegram video: ${videoFile.filename || "twitter-video.mp4"}`);
  return callTelegramMultipartLogged(botToken, "sendVideo", form, queueItemId, signal);
}
/** Send a text message to Telegram. */
async function sendTelegramMessage(botToken, chatId, text, queueItemId = "", signal = null) {
  await markTelegramUploadProgress(queueItemId);
  return callTelegram(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false
  }, signal);
}
/** Verify that a Telegram chat exists and the bot is a member. */
async function validateTelegramChat(botToken, chatId, signal = null) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getChat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
    signal
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const description = data?.description || `${response.status} ${response.statusText}`;
    throw new Error(`Channel validation failed (${chatId}): ${description}`);
  }
  return data.result;
}
/** Call a Telegram Bot API method with JSON body. */
async function callTelegram(botToken, method, body, signal = null) {
  const response = await runTelegramSendQueued(body?.chat_id, signal, () => fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  }));
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const description = data?.description || `${response.status} ${response.statusText}`;
    throw createTelegramApiError(description, data);
  }
  return data.result;
}
/** Call a Telegram Bot API method with multipart upload, timeout, and debug logging. */
async function callTelegramMultipart(botToken, method, body, queueItemId = "", signal = null) {
  const startedAt = Date.now();
  await appendQueueDebugLog(queueItemId, `Calling Telegram ${method}`);
  let controller = null;
  let timeoutId = null;
  const abortUpload = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    controller?.abort();
  };
  signal?.addEventListener?.("abort", abortUpload, { once: true });
  const response = await runTelegramSendQueued(body.get("chat_id"), signal, () => {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), TELEGRAM_UPLOAD_TIMEOUT_MS);
    return fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      body,
      signal: controller.signal
    });
  }).catch((error) => {
    if (error?.name === "AbortError") {
      throw signal?.aborted ? createCancelledError() : new Error(__t("bg_uploadTimeout"));
    }
    throw error;
  }).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    signal?.removeEventListener?.("abort", abortUpload);
  });
  await appendQueueDebugLog(queueItemId, `Telegram ${method} HTTP ${response.status}, took ${formatDuration(Date.now() - startedAt)}`);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const description = data?.description || `${response.status} ${response.statusText}`;
    await appendQueueDebugLog(queueItemId, `Telegram ${method} error: ${description}`);
    throw createTelegramApiError(description, data);
  }
  await appendQueueDebugLog(queueItemId, `Telegram ${method} succeeded`);
  return data.result;
}
/** Call a Telegram Bot API multipart method with debug logging wrapper. */
async function callTelegramMultipartLogged(botToken, method, body, queueItemId = "", signal = null) {
  const startedAt = Date.now();
  await appendQueueDebugLog(queueItemId, `Calling Telegram ${method}`);
  debugLog(queueItemId, `Telegram ${method} request started`, describeFormData(body));
  let controller = null;
  let timeoutId = null;
  const abortUpload = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    controller?.abort();
  };
  signal?.addEventListener?.("abort", abortUpload, { once: true });
  const response = await runTelegramSendQueued(body.get("chat_id"), signal, () => {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), TELEGRAM_UPLOAD_TIMEOUT_MS);
    return fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      body,
      signal: controller.signal
    });
  }).catch((error) => {
    debugError(queueItemId, `Telegram ${method} request failed before response`, error);
    if (error?.name === "AbortError") {
      throw signal?.aborted ? createCancelledError() : new Error(__t("bg_uploadTimeout"));
    }
    throw error;
  }).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    signal?.removeEventListener?.("abort", abortUpload);
  });
  await appendQueueDebugLog(queueItemId, `Telegram ${method} HTTP ${response.status}, elapsed ${formatDuration(Date.now() - startedAt)}`);
  debugLog(queueItemId, `Telegram ${method} response received`, {
    status: response.status,
    elapsedMs: Date.now() - startedAt
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const description = data?.description || `${response.status} ${response.statusText}`;
    await appendQueueDebugLog(queueItemId, `Telegram ${method} error: ${description}`);
    debugError(queueItemId, `Telegram ${method} API error`, description);
    throw createTelegramApiError(description, data);
  }
  await appendQueueDebugLog(queueItemId, `Telegram ${method} success`);
  debugLog(queueItemId, `Telegram ${method} success`);
  return data.result;
}
function describeFormData(form) {
  const entries = [];
  for (const [key, value] of form.entries()) {
    if (value instanceof Blob) {
      entries.push({
        key,
        fileName: value.name || "",
        size: value.size,
        type: value.type || ""
      });
      continue;
    }
    entries.push({
      key,
      value: String(value).slice(0, 200)
    });
  }
  return entries;
}
function createTelegramApiError(description, data) {
  const error = new Error(__t("bg_telegramApiFailed", [description]));
  error.code = "TELEGRAM_API_ERROR";
  error.retryAfter = getTelegramRetryAfter(data) || getRetryAfterFromMessage(description);
  return error;
}
/**
 * Serialize Telegram send calls per chat and keep a short gap between sends.
 *
 * Do not sleep through Telegram flood-control retry_after here and do not
 * auto-retry 429s from the service worker. Long SW sleeps are brittle, and
 * retry_after should remain a visible queue-item error for manual retry.
 */
async function runTelegramSendQueued(chatId, signal, operation) {
  const key = String(chatId || "").trim();
  if (!key) {
    return operation();
  }

  const previous = telegramSendQueuesByChat.get(key) || Promise.resolve();
  const run = previous.catch(() => { }).then(async () => {
    throwIfAborted(signal);
    const lastSendAt = Number(telegramLastSendAtByChat.get(key) || 0);
    const waitMs = Math.max(0, lastSendAt + TELEGRAM_SEND_MIN_INTERVAL_MS - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs, signal);
    }
    telegramLastSendAtByChat.set(key, Date.now());
    return operation();
  });
  const queued = run.finally(() => {
    if (telegramSendQueuesByChat.get(key) === queued) {
      telegramSendQueuesByChat.delete(key);
    }
  });
  telegramSendQueuesByChat.set(key, queued);
  return queued;
}
function getQueueErrorMessage(error) {
  const message = error?.message || String(error);
  const retryAfter = getErrorRetryAfter(error);
  return retryAfter > 0 ? `${message}; retry manually after ${retryAfter}s` : message;
}
function getRetryAfterUntil(error) {
  const retryAfter = getErrorRetryAfter(error);
  return retryAfter > 0 ? Date.now() + (retryAfter * 1000) : 0;
}
function getErrorRetryAfter(error) {
  const direct = Number(error?.retryAfter || 0);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.ceil(direct);
  }
  return getRetryAfterFromMessage(error?.message || String(error || ""));
}
function getTelegramRetryAfter(data) {
  const value = Number(data?.parameters?.retry_after || 0);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}
function getRetryAfterFromMessage(message) {
  const match = String(message || "").match(/retry after\s+(\d+)/i);
  return match ? Math.max(1, Number(match[1])) : 0;
}
