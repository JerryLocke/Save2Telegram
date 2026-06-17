import { AppError, Err } from "./errors.js";
import { TELEGRAM_API_BASE } from "./config.js";

const TELEGRAM_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TELEGRAM_UPLOAD_RETRIES = Math.max(0, Number(process.env.TELEGRAM_UPLOAD_RETRIES || 2));
const TELEGRAM_RETRY_BASE_DELAY_MS = 1200;
const TELEGRAM_SEND_MIN_INTERVAL_MS = Math.max(0, Number(process.env.TELEGRAM_SEND_MIN_INTERVAL_MS || 1250));
const telegramSendQueuesByChat = new Map();
const telegramLastSendAtByChat = new Map();
const telegramRetryAfterUntilByChat = new Map();

/** Verify a Telegram chat exists and the bot has access. Throws on failure. */
export async function validateTelegramChat(botToken, chatId, signal) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getChat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ chat_id: chatId })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new AppError(Err.VALIDATION_FAILED, data?.description || `${response.status} ${response.statusText}`);
  }
  return data.result;
}

/** Send a photo to a Telegram chat. */
export async function sendTelegramPhoto(botToken, chatId, photo, caption, signal) {
  return callTelegram(botToken, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML" }, signal);
}

/** Upload and send a video file (Blob) to a Telegram chat. */
export async function sendTelegramVideoFile(botToken, chatId, videoFile, caption, options = {}) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("video", videoFile.blob, videoFile.filename);
  form.set("supports_streaming", "true");
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }

  return callTelegramMultipart(botToken, "sendVideo", form, options);
}

/** Send a text message to a Telegram chat with HTML parsing. */
export async function sendTelegramMessage(botToken, chatId, text, signal) {
  return callTelegram(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false
  }, signal);
}

/** Call a Telegram Bot API JSON method. */
async function callTelegram(botToken, method, body, signal) {
  const response = await runTelegramSendQueued(body?.chat_id, signal, () => fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body)
  }));
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    rememberTelegramRetryAfter(body?.chat_id, getTelegramRetryAfter(data));
    throw createTelegramApiError(response, data);
  }
  return data.result;
}

/** Call a Telegram Bot API method with multipart/form-data upload and progress tracking. */
export async function callTelegramMultipart(botToken, method, body, options = {}) {
  const cancelSignal = isAbortSignal(options) ? options : options?.signal;
  const onUploadProgress = isAbortSignal(options) ? null : options?.onUploadProgress;
  let lastError = null;

  for (let attempt = 0; attempt <= TELEGRAM_UPLOAD_RETRIES; attempt += 1) {
    throwIfAborted(cancelSignal);

    let timedOut = false;
    let timeoutId = null;
    let controller = null;
    const abortUpload = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      controller?.abort();
    };
    cancelSignal?.addEventListener?.("abort", abortUpload, { once: true });

    try {
      const response = await runTelegramSendQueued(body.get("chat_id"), cancelSignal, () => {
        controller = new AbortController();
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, TELEGRAM_UPLOAD_TIMEOUT_MS);
        const multipart = createMultipartBody(body, onUploadProgress);
        return fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
          method: "POST",
          headers: {
            "Content-Type": multipart.contentType,
            "Content-Length": String(multipart.contentLength)
          },
          body: multipart.body,
          duplex: "half",
          signal: controller.signal
        });
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const retryAfter = getTelegramRetryAfter(data);
        rememberTelegramRetryAfter(body.get("chat_id"), retryAfter);
        if (!retryAfter && shouldRetryTelegramResponse(response, attempt)) {
          lastError = createTelegramApiError(response, data);
          await waitForRetry(attempt, cancelSignal, retryAfter);
          continue;
        }

        throw createTelegramApiError(response, data);
      }
      return data.result;
    } catch (error) {
      if (error?.name === "AbortError") {
        if (cancelSignal?.aborted && !timedOut) {
          throw new AppError(Err.CANCELLED, "Task cancelled by user.");
        }

        throw new AppError(Err.UPLOAD_TIMEOUT, "Telegram upload timed out. Check the network or video file size and try again.");
      }

      if (error instanceof AppError) {
        throw error;
      }

      if (isRetryableUploadError(error) && attempt < TELEGRAM_UPLOAD_RETRIES) {
        lastError = error;
        await waitForRetry(attempt, cancelSignal);
        continue;
      }

      throw new AppError(Err.TELEGRAM_API_ERROR, `Telegram upload failed: ${describeUploadError(error)}`);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      cancelSignal?.removeEventListener?.("abort", abortUpload);
    }
  }

  throw new AppError(Err.TELEGRAM_API_ERROR, `Telegram upload failed: ${describeUploadError(lastError)}`);
}

/** Check if a value is an AbortSignal instance (cross-realm compatible). */
function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}

/** Throw a cancellation error if the caller has already aborted the upload. */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AppError(Err.CANCELLED, "Task cancelled by user.");
  }
}

/**
 * Serialize Telegram send calls per chat and keep a small gap between sends.
 *
 * Important: if Telegram has already returned flood-control retry_after for a
 * chat, the backend fails fast instead of sleeping until the cooldown expires.
 * Long server-side sleeps make jobs hard to test, cancel, and reason about.
 * The extension should surface retry_after to the user and let the user retry.
 */
async function runTelegramSendQueued(chatId, signal, operation) {
  const key = String(chatId || "").trim();
  if (!key) {
    return operation();
  }

  const previous = telegramSendQueuesByChat.get(key) || Promise.resolve();
  const run = previous.catch(() => { }).then(async () => {
    throwIfAborted(signal);
    const cooldownUntil = Number(telegramRetryAfterUntilByChat.get(key) || 0);
    const cooldownWaitMs = Math.max(0, cooldownUntil - Date.now());
    if (cooldownWaitMs > 0) {
      throw createTelegramFloodControlError(Math.ceil(cooldownWaitMs / 1000));
    }
    const lastSendAt = Number(telegramLastSendAtByChat.get(key) || 0);
    const waitMs = Math.max(0, lastSendAt + TELEGRAM_SEND_MIN_INTERVAL_MS - Date.now());
    if (waitMs > 0) {
      await sleepWithAbort(waitMs, signal);
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

function rememberTelegramRetryAfter(chatId, retryAfter) {
  const key = String(chatId || "").trim();
  const seconds = Number(retryAfter || 0);
  if (!key || !Number.isFinite(seconds) || seconds <= 0) {
    return;
  }

  const until = Date.now() + (Math.ceil(seconds) * 1000);
  telegramRetryAfterUntilByChat.set(key, Math.max(Number(telegramRetryAfterUntilByChat.get(key) || 0), until));
}

function createTelegramFloodControlError(retryAfter) {
  return new AppError(Err.TELEGRAM_API_ERROR, `Telegram flood control: retry manually after ${retryAfter}s`, {
    retryAfter,
    telegramStatus: 429
  });
}

/** Return true for transient Telegram responses that are safe to retry automatically. */
function shouldRetryTelegramResponse(response, attempt) {
  if (attempt >= TELEGRAM_UPLOAD_RETRIES) {
    return false;
  }

  return response?.status >= 500 && response?.status <= 599;
}

/** Return true for transient network failures seen during streaming uploads. */
function isRetryableUploadError(error) {
  const code = error?.cause?.code || error?.code;
  return error?.name === "TypeError" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED";
}

/** Wait before retrying an upload, while still honoring cancellation. */
function waitForRetry(attempt, signal, retryAfter = 0) {
  const delay = retryAfter > 0
    ? (retryAfter * 1000) + 1000
    : TELEGRAM_RETRY_BASE_DELAY_MS * (2 ** attempt);
  return sleepWithAbort(delay, signal);
}

/** Sleep while preserving cancellation semantics. */
function sleepWithAbort(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(Err.CANCELLED, "Task cancelled by user."));
      return;
    }

    const timeoutId = setTimeout(resolve, delay);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timeoutId);
      reject(new AppError(Err.CANCELLED, "Task cancelled by user."));
    }, { once: true });
  });
}

/** Build a Telegram API error while preserving flood-control retry metadata. */
function createTelegramApiError(response, data) {
  const description = data?.description || `${response.status} ${response.statusText}`;
  const retryAfter = getTelegramRetryAfter(data);
  return new AppError(Err.TELEGRAM_API_ERROR, `Telegram API call failed: ${description}`, {
    retryAfter,
    telegramStatus: response.status
  });
}

/** Extract Telegram flood-control retry_after seconds from API response JSON. */
function getTelegramRetryAfter(data) {
  const value = Number(data?.parameters?.retry_after || 0);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

/** Format nested undici/network errors without leaking the whole stack to clients. */
function describeUploadError(error) {
  const message = error?.cause?.message || error?.message || String(error || "unknown error");
  const code = error?.cause?.code || error?.code || "";
  return code ? `${message} (${code})` : message;
}

/** Build a multipart/form-data body from a FormData object with optional upload progress callback. */
function createMultipartBody(form, onProgress = null) {
  const boundary = `----Save2Telegram${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts = [...form.entries()].map(([name, value]) => createMultipartPart(boundary, name, value, encoder));
  const closing = encoder.encode(`--${boundary}--\r\n`);
  const contentLength = parts.reduce((total, part) => total + part.size, 0) + closing.byteLength;
  let loaded = 0;

  const report = (delta) => {
    loaded += delta;
    onProgress?.({ loaded, total: contentLength });
  };

  const body = new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(part.header);
        report(part.header.byteLength);

        if (part.blob) {
          for await (const chunk of part.blob.stream()) {
            controller.enqueue(chunk);
            report(chunk.byteLength);
          }
        } else {
          controller.enqueue(part.content);
          report(part.content.byteLength);
        }

        controller.enqueue(part.footer);
        report(part.footer.byteLength);
      }

      controller.enqueue(closing);
      report(closing.byteLength);
      controller.close();
    }
  });

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength
  };
}

/** Create a single multipart part (header + data) for the given field. */
function createMultipartPart(boundary, name, value, encoder) {
  if (typeof value === "string") {
    const header = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n`);
    const content = encoder.encode(value);
    const footer = encoder.encode("\r\n");
    return { header, content, footer, size: header.byteLength + content.byteLength + footer.byteLength };
  }

  const filename = value?.name || "blob";
  const contentType = value?.type || "application/octet-stream";
  const header = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${escapeMultipartName(name)}"; filename="${escapeMultipartName(filename)}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const footer = encoder.encode("\r\n");
  return { header, blob: value, footer, size: header.byteLength + Number(value?.size || 0) + footer.byteLength };
}

/** Escape special characters in a multipart field name per RFC 2047. */
function escapeMultipartName(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, " ");
}
