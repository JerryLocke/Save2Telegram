import { escapeHtml } from "./http-utils.js";
import { SETUP_PAGE_MESSAGES } from "./setup-page.messages.js";

/** Validate and normalize a locale string to 'en' or 'zh_CN'. */
export function normalizeSetupLocale(value) {
  if (value === "zh-CN" || value === "zh_CN" || value === "zh") return "zh_CN";
  return "en";
}

/** Resolve the setup page locale from query param, cookie, or Accept-Language header. */
export function resolveSetupLocale(req, requestedLocale) {
  if (requestedLocale) return normalizeSetupLocale(requestedLocale);
  const cookie = (req.headers.cookie || "").match(/locale=([^;]+)/);
  if (cookie) return normalizeSetupLocale(cookie[1]);
  const acceptLang = parseAcceptLanguage(req.headers["accept-language"] || "");
  for (const lang of acceptLang) {
    const normalized = normalizeSetupLocale(lang);
    if (normalized !== "en") return normalized;
  }
  return "en";
}

/** Parse Accept-Language header into an ordered list of language tags, respecting quality values. */
function parseAcceptLanguage(header) {
  const tags = [];
  for (const part of header.split(",")) {
    const [tag, q] = part.trim().split(";");
    const lang = (tag || "").trim();
    if (!lang) continue;
    const quality = q ? parseFloat(q.replace(/^q\s*=\s*/, "")) : 1;
    if (isNaN(quality)) continue;
    tags.push({ lang: lang.replace(/-/g, "_"), quality });
    // Also add the primary language subtag for broader matching (e.g. "zh" from "zh_CN")
    const primary = lang.split("-")[0].replace(/_/g, "");
    if (primary && primary !== lang) {
      tags.push({ lang: primary, quality: quality * 0.99 });
    }
  }
  return tags.sort((a, b) => b.quality - a.quality).map((t) => t.lang);
}

/** Render the full setup page HTML. */
export function renderSetupPage(endpointUrl, extensionId, appName = "Save2Telegram", backendVersion = "", locale = "en", hasSecret = false, setupSecret = "") {
  const msg = SETUP_PAGE_MESSAGES[locale] || SETUP_PAGE_MESSAGES.en;
  const normalizedAppName = String(appName || "Save2Telegram").trim() || "Save2Telegram";
  const normalizedBackendVersion = String(backendVersion || "").trim();
  const t = (value) => String(value || "").replaceAll("{appName}", normalizedAppName);
  const extensionStoreUrl = extensionId
    ? `https://chromewebstore.google.com/detail/${encodeURIComponent(extensionId)}`
    : "";
  const extensionCheckScript = extensionId ? `
    window.__EXTENSION_ID__ = "${extensionId}";
    window.__EXTENSION_SETUP_ORIGIN__ = "chrome-extension://" + window.__EXTENSION_ID__;
  ` : "";
  const hasSecretScript = hasSecret ? `window.__SETUP_SECRET__ = "${setupSecret}";` : "";

  return `<!doctype html>
<html lang="${msg.lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(t(msg.title))}</title>
    ${extensionStoreUrl ? `<link rel="chrome-webstore-item" href="${escapeHtml(extensionStoreUrl)}">` : ""}
    <style>
      /* Minimal setup page styles */
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
      .page { width: 90%; max-width: 480px; }
      .card { background: #fff; border-radius: 12px; padding: 40px; width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
      h1 { font-size: 24px; margin-bottom: 8px; }
      .description { color: #666; font-size: 13px; line-height: 1.5; margin: 0 0 24px; }
      .label { color: #999; font-size: 13px; margin: 24px 0 8px; }
      .version { color: #999; font-size: 13px; margin-top: 14px; text-align: center; }
      p { color: #666; margin-bottom: 24px; }
      .url { background: #f5f5f5; padding: 12px; border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 14px; margin: 0 0 24px; }
      .status { margin-bottom: 16px; font-size: 14px; min-height: 20px; }
      .status.ok { color: #22c55e; }
      .status.err { color: #ef4444; }
      button { width: 100%; padding: 12px; border-radius: 8px; border: none; font-size: 16px; cursor: pointer; }
      button.primary { background: #229ed9; color: #fff; }
      button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
      button.secondary { background: #e5e5e5; color: #333; margin-top: 8px; }
      a.store-link { display: block; text-align: center; margin-top: 12px; padding: 12px; border-radius: 8px; color: #229ed9; background: #eef8fd; text-decoration: none; font-size: 14px; }
      a.store-link:hover { background: #dff1fb; }
      .note { margin-top: 20px; font-size: 12px; color: #999; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="card">
        <h1>${escapeHtml(t(msg.heading))}</h1>
        <p class="description">${escapeHtml(t(msg.endpointDescription))}</p>
        <p class="label">${escapeHtml(msg.endpointLabel)}</p>
        <p class="url">${endpointUrl}</p>
        <p id="status" class="status"></p>
        <button id="setup-btn" class="primary" onclick="setupEndpoint()">${msg.useEndpoint}</button>
        ${extensionStoreUrl ? `<a class="store-link" href="${escapeHtml(extensionStoreUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(msg.installExtension))}</a>` : ""}
      </div>
      ${normalizedBackendVersion ? `<p class="version">Backend v${escapeHtml(normalizedBackendVersion)}</p>` : ""}
    </div>
    <script>
    ${extensionCheckScript}
    ${hasSecretScript}
    async function setupEndpoint() {
      const btn = document.getElementById("setup-btn");
      const status = document.getElementById("status");
      btn.disabled = true;
      status.className = "status";
      status.textContent = "";

      try {
        const keyRes = await fetch("./api/keys", {
          method: "POST",
          headers: window.__SETUP_SECRET__
            ? { Authorization: "Bearer " + window.__SETUP_SECRET__ }
            : {}
        });
        if (!keyRes.ok) {
          const d = await keyRes.json().catch(() => ({}));
          throw new Error(d.error || "${msg.keyFailed}");
        }
        const { uid, key } = await keyRes.json();

        if (window.chrome?.runtime?.id) {
          // Running inside the extension - send directly
          const response = await chrome.runtime.sendMessage({
            type: "SET_FORWARD_ENDPOINT",
            endpointUrl: window.location.origin,
            setupUrl: window.location.href,
            key: key
          });
          if (!response?.ok) throw new Error(response?.error || "${msg.setupFailed}");
          status.textContent = "${msg.setupDone}";
          status.className = "status ok";
        } else if (window.__EXTENSION_ID__) {
          // Try extension messaging API
          const extId = window.__EXTENSION_ID__;
          const response = await chrome.runtime.sendMessage(extId, {
            type: "SET_FORWARD_ENDPOINT",
            endpointUrl: window.location.origin,
            setupUrl: window.location.href,
            key: key
          });
          if (!response?.ok) throw new Error(response?.error || "${msg.setupFailed}");
          status.textContent = "${msg.setupDone}";
          status.className = "status ok";
        } else {
          throw new Error(${JSON.stringify(t(msg.extensionNotFound))});
        }
      } catch (error) {
        status.textContent = error.message || "${msg.setupFailed}";
        status.className = "status err";
        btn.disabled = false;
      }
    }
    </script>
  </body>
</html>`;
}
