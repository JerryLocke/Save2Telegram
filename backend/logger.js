import crypto from "node:crypto";

/** Create a request context object with a unique request ID and timing. */
export function createRequestContext(req, res) {
  return {
    id: crypto.randomUUID().slice(0, 8),
    method: req.method,
    path: req.url,
    startedAt: Date.now(),
    isSse: false,
    error: ""
  };
}

/** Log the start of an incoming request. */
export function logRequestStart(req, context) {
  console.info("[" + context.id + "] >> " + context.method + " " + context.path);
}

/** Log a forward request body (with sensitive fields masked). */
export function logForwardRequest(body, context) {
  const telegram = body?.telegram || {};
  const safe = {
    tweetUrl: body?.payload?.tweetUrl || "",
    mediaCount: body?.payload?.mediaItems?.length || 0,
    botToken: maskTail(telegram.botToken || ""),
    chatId: telegram.chatId || ""
  };
  console.info("[" + context.id + "] Forward request:", safe);
}

/** Log the end of a request with duration and any error. */
export function logRequestEnd(req, context) {
  const elapsed = Date.now() - context.startedAt;
  const suffix = context.error ? " ERROR: " + context.error : "";
  console.info("[" + context.id + "] << " + elapsed + "ms" + suffix);
}

/** Show only the last 8 characters of a sensitive value. */
function maskTail(value) {
  if (!value || value.length <= 8) return value;
  return "..." + value.slice(-8);
}
