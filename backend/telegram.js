import { AppError, Err } from "./errors.js";
import { TELEGRAM_API_BASE } from "./config.js";
import http from "node:http";
import https from "node:https";

const TELEGRAM_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TELEGRAM_UPLOAD_RETRIES = Math.max(0, Number(process.env.TELEGRAM_UPLOAD_RETRIES || 2));
const TELEGRAM_RETRY_BASE_DELAY_MS = 1200;
const TELEGRAM_SEND_MIN_INTERVAL_MS = Math.max(0, Number(process.env.TELEGRAM_SEND_MIN_INTERVAL_MS || 1250));
const TELEGRAM_RESPONSE_MAX_BYTES = Math.max(16 * 1024, Number(process.env.TELEGRAM_RESPONSE_MAX_BYTES || 1024 * 1024));
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

/** Upload and send a photo file to a Telegram chat. */
export async function sendTelegramPhotoFile(botToken, chatId, photoFile, caption, options = {}) {
  const form = createMultipartForm();
  form.set("chat_id", chatId);
  form.set("photo", photoFile, photoFile.filename);
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }

  return callTelegramMultipart(botToken, "sendPhoto", form, options);
}

/** Upload and send a video file to a Telegram chat. */
export async function sendTelegramVideoFile(botToken, chatId, videoFile, caption, options = {}) {
  const form = createMultipartForm();
  form.set("chat_id", chatId);
  form.set("video", videoFile, videoFile.filename);
  form.set("supports_streaming", "true");
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }

  return callTelegramMultipart(botToken, "sendVideo", form, options);
}

/** Create a small FormData-compatible object that preserves retryable disk file streams. */
export function createMultipartForm() {
  return new MultipartForm();
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
        return sendMultipartRequest(botToken, method, multipart, controller.signal);
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

    let timeoutId = null;
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new AppError(Err.CANCELLED, "Task cancelled by user."));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    signal?.addEventListener?.("abort", onAbort, { once: true });
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

/** POST multipart data with Node streams so large files obey socket backpressure. */
function sendMultipartRequest(botToken, method, multipart, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    let requestBodyEnded = false;
    let responseReceived = false;
    let request = null;
    const stopWritingController = new AbortController();

    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      request?.destroy(createAbortError());
    };

    request = transport.request(url, {
      method: "POST",
      headers: {
        "Content-Type": multipart.contentType,
        "Content-Length": String(multipart.contentLength)
      }
    }, (response) => {
      responseReceived = true;
      stopWritingController.abort();
      const chunks = [];
      let responseBytes = 0;
      response.on("data", (chunk) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > TELEGRAM_RESPONSE_MAX_BYTES) {
          settle(reject, new AppError(Err.TELEGRAM_API_ERROR, `Telegram API response exceeds ${formatBytes(TELEGRAM_RESPONSE_MAX_BYTES)}.`));
          response.destroy();
          request.destroy();
          return;
        }

        chunks.push(chunk);
      });
      response.on("end", () => {
        settle(resolve, createBufferedResponse(response, chunks));
        if (!requestBodyEnded) {
          request.destroy();
        }
      });
      response.on("error", (error) => {
        settle(reject, error);
      });
    });

    request.on("error", (error) => {
      if (responseReceived) {
        return;
      }
      settle(reject, error);
    });

    if (signal?.aborted) {
      request.destroy(createAbortError());
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    writeMultipartRequest(request, multipart.body, signal, stopWritingController.signal)
      .then((bodyEnded) => {
        requestBodyEnded = bodyEnded;
      })
      .catch((error) => {
        if (!settled) {
          request.destroy(error);
        }
      });
  });
}

async function writeMultipartRequest(request, body, signal, stopSignal) {
  for await (const chunk of body) {
    if (stopSignal?.aborted) {
      return false;
    }

    throwIfAbortedSignal(signal);
    if (!request.write(chunk)) {
      await waitForRequestDrain(request, signal, stopSignal);
    }
  }

  if (!stopSignal?.aborted) {
    request.end();
    return true;
  }

  return false;
}

function waitForRequestDrain(request, signal, stopSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    if (stopSignal?.aborted) {
      resolve();
      return;
    }

    const cleanup = () => {
      request.off("drain", onDrain);
      request.off("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
      stopSignal?.removeEventListener?.("abort", onStop);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const onStop = () => {
      cleanup();
      resolve();
    };

    request.once("drain", onDrain);
    request.once("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    stopSignal?.addEventListener?.("abort", onStop, { once: true });
  });
}

function throwIfAbortedSignal(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError() {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function createBufferedResponse(response, chunks) {
  const body = Buffer.concat(chunks).toString("utf-8");
  return {
    ok: response.statusCode >= 200 && response.statusCode <= 299,
    status: response.statusCode || 0,
    statusText: response.statusMessage || "",
    async json() {
      return JSON.parse(body);
    }
  };
}

function formatBytes(bytes) {
  const megabytes = Number(bytes || 0) / 1024 / 1024;
  return megabytes >= 1 ? `${Math.round(megabytes * 10) / 10} MB` : `${Math.round(Number(bytes || 0) / 1024)} KB`;
}

/** Build a multipart/form-data body from a FormData object with optional upload progress callback. */
function createMultipartBody(form, onProgress = null) {
  const boundary = `----Save2Telegram${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  // Build metadata up front so Content-Length is known before streaming starts.
  const parts = [...form.entries()].map(([name, value]) => createMultipartPart(boundary, name, value, encoder));
  const closing = encoder.encode(`--${boundary}--\r\n`);
  const contentLength = parts.reduce((total, part) => total + part.size, 0) + closing.byteLength;
  let loaded = 0;

  const report = (delta) => {
    loaded += delta;
    onProgress?.({ loaded, total: contentLength });
  };

  return {
    body: iterMultipartBody(parts, closing, report),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength
  };
}

async function* iterMultipartBody(parts, closing, report) {
  for (const part of parts) {
    yield part.header;
    report(part.header.byteLength);

    if (part.file) {
      for await (const chunk of part.file.stream()) {
        yield chunk;
        report(chunk.byteLength);
      }
    } else {
      yield part.content;
      report(part.content.byteLength);
    }

    yield part.footer;
    report(part.footer.byteLength);
  }

  yield closing;
  report(closing.byteLength);
}

/** Create a single multipart part (header + data) for the given field. */
function createMultipartPart(boundary, name, value, encoder) {
  if (typeof value === "string") {
    const header = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n`);
    const content = encoder.encode(value);
    const footer = encoder.encode("\r\n");
    return { header, content, footer, size: header.byteLength + content.byteLength + footer.byteLength };
  }

  const filename = value?.filename || value?.name || "blob";
  const contentType = value?.type || value?.contentType || "application/octet-stream";
  const header = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${escapeMultipartName(name)}"; filename="${escapeMultipartName(filename)}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const footer = encoder.encode("\r\n");
  return { header, file: value, footer, size: header.byteLength + Number(value?.size || 0) + footer.byteLength };
}

class MultipartForm {
  constructor() {
    this.fields = [];
  }

  set(name, value, filename = "") {
    const key = String(name);
    const entry = [key, normalizeMultipartValue(value, filename)];
    const existingIndex = this.fields.findIndex(([fieldName]) => fieldName === key);
    if (existingIndex >= 0) {
      this.fields[existingIndex] = entry;
      return;
    }

    this.fields.push(entry);
  }

  get(name) {
    const key = String(name);
    return this.fields.find(([fieldName]) => fieldName === key)?.[1] ?? null;
  }

  entries() {
    return this.fields[Symbol.iterator]();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

function normalizeMultipartValue(value, filename = "") {
  if (typeof value === "string") {
    return value;
  }

  if (value?.blob) {
    // Accept older { blob, filename } call sites while the backend migrates to disk-backed files.
    return normalizeMultipartValue(value.blob, filename || value.filename || value.name);
  }

  const name = filename || value?.filename || value?.name || "blob";
  return {
    source: value,
    filename: name,
    name,
    type: value?.type || value?.contentType || "application/octet-stream",
    size: Number(value?.size || 0),
    stream() {
      return value.stream();
    }
  };
}

/** Escape special characters in a multipart field name per RFC 2047. */
function escapeMultipartName(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, " ");
}
