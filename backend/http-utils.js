import { AppError, Err } from "./errors.js";

const JSON_BODY_MAX_BYTES = parseByteLimit(process.env.JSON_BODY_MAX_BYTES, 1024 * 1024);

/** Parse the request body as JSON. Rejects on invalid JSON. */
export async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;

    req.on("data", (chunk) => {
      if (rejected) {
        return;
      }

      total += chunk.byteLength;
      if (total > JSON_BODY_MAX_BYTES) {
        rejected = true;
        reject(new AppError(Err.PAYLOAD_TOO_LARGE, `JSON request body exceeds ${formatBytes(JSON_BODY_MAX_BYTES)}.`));
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) {
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new AppError(Err.VALIDATION_FAILED, "Invalid JSON body."));
      }
    });
    req.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

/** Send a JSON response with the given status code and body. */
export function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(data);
}

/** Send a 204 No Content response for CORS preflight. */
export function sendOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end();
}

/** Send an HTML response. */
export function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Resolve the public-facing endpoint URL from request or env. */
export function getEndpointUrl(req, publicUrl = "", port = 3000) {
  return publicUrl || `${getRequestOrigin(req, port)}`;
}

/** Resolve the request origin from Host header or fallback to localhost. */
export function getRequestOrigin(req, port = 3000) {
  const host = req.headers.host || `localhost:${port}`;
  const proto = req.socket?.encrypted ? "https" : "http";
  return `${proto}://${host}`;
}

/** Normalize an endpoint URL: ensure https?:// prefix, strip trailing slash. */
export function normalizeEndpointUrl(value) {
  if (!value) return "";
  let url = String(value).trim();
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url.replace(/\/+$/, "");
}

/** Escape HTML special characters for safe embedding. */
export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function parseByteLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatBytes(bytes) {
  const megabytes = Number(bytes || 0) / 1024 / 1024;
  return megabytes >= 1 ? `${Math.round(megabytes * 10) / 10} MB` : `${Math.round(Number(bytes || 0) / 1024)} KB`;
}
