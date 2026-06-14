import { AppError, Err } from "./errors.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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
  });
}

/** Call a Telegram Bot API JSON method. */
async function callTelegram(botToken, method, body, signal) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new AppError(Err.TELEGRAM_API_ERROR, `Telegram API call failed: ${data?.description || `${response.status} ${response.statusText}`}`);
  }
  return data.result;
}

/** Call a Telegram Bot API method with multipart/form-data upload and progress tracking. */
export async function callTelegramMultipart(botToken, method, body, options = {}) {
  const cancelSignal = isAbortSignal(options) ? options : options?.signal;
  const onUploadProgress = isAbortSignal(options) ? null : options?.onUploadProgress;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_UPLOAD_TIMEOUT_MS);
  if (cancelSignal?.aborted) controller.abort();
  else cancelSignal?.addEventListener?.("abort", () => { clearTimeout(timeoutId); controller.abort(); });
  const multipart = createMultipartBody(body, onUploadProgress);
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": multipart.contentType,
      "Content-Length": String(multipart.contentLength)
    },
    body: multipart.body,
    duplex: "half",
    signal: controller.signal
  }).catch((error) => {
    if (error?.name === "AbortError") {
      throw new AppError(Err.UPLOAD_TIMEOUT, "Telegram upload timed out. Check the network or video file size and try again.");
    }

    throw error;
  }).finally(() => clearTimeout(timeoutId));

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new AppError(Err.TELEGRAM_API_ERROR, `Telegram API call failed: ${data?.description || `${response.status} ${response.statusText}`}`);
  }
  return data.result;
}

/** Check if a value is an AbortSignal instance (cross-realm compatible). */
function isAbortSignal(value) {
  return value && typeof value === "object" && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
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
