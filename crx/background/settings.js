async function getTelegramConfigs() {
  const data = await chrome.storage.sync.get([TELEGRAM_CONFIGS_KEY, "botToken", "chatId"]);
  const configs = normalizeTelegramConfigs(data[TELEGRAM_CONFIGS_KEY]);
  if (configs.length) {
    return configs;
  }
  const botToken = typeof data.botToken === "string" ? data.botToken.trim() : "";
  const chatId = typeof data.chatId === "string" ? data.chatId.trim() : "";
  if (!botToken || !chatId) {
    return [];
  }
  const now = Date.now();
  const migrated = [{
    id: createTelegramConfigId(),
    note: "",
    botToken,
    chatId,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0
  }];
  await writeTelegramConfigs(migrated);
  return migrated;
}
async function saveTelegramConfig(config) {
  const requestedBotToken = String(config?.botToken || "").trim();
  const chatId = String(config?.chatId || "").trim();
  const note = String(config?.note || "").trim();
  const now = Date.now();
  const configs = await getTelegramConfigs();
  const id = String(config?.id || "").trim() || createTelegramConfigId();
  const existing = configs.find((entry) => entry.id === id);
  const botToken = requestedBotToken || existing?.botToken || "";
  if (!note || !botToken || !chatId) {
    throw new Error(__t("bg_missingConfigFields"));
  }
  const nextConfig = {
    id,
    note,
    botToken,
    chatId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || 0
  };
  const nextConfigs = existing
    ? configs.map((entry) => entry.id === id ? nextConfig : entry)
    : [...configs, nextConfig];
  await writeTelegramConfigs(nextConfigs);
  return nextConfigs;
}
async function deleteTelegramConfig(id) {
  const configId = String(id || "").trim();
  if (!configId) {
    throw new Error(__t("bg_missingConfigId"));
  }
  const configs = await getTelegramConfigs();
  const nextConfigs = configs.filter((entry) => entry.id !== configId);
  await writeTelegramConfigs(nextConfigs);
  return nextConfigs;
}
/** Load general settings from chrome.storage.sync with defaults. */
async function getGeneralSettings() {
  const data = await chrome.storage.sync.get(GENERAL_SETTINGS_KEY);
  return normalizeGeneralSettings(data[GENERAL_SETTINGS_KEY]);
}
async function saveGeneralSettings(settings) {
  const currentSettings = await getGeneralSettings();
  const nextSettings = normalizeGeneralSettings({
    ...currentSettings,
    ...settings
  });
  await chrome.storage.sync.set({ [GENERAL_SETTINGS_KEY]: nextSettings });
  if (!nextSettings.keepCompletedItems) {
    await clearCompletedQueueItems();
  } else {
    await trimCompletedQueueItems(nextSettings.maxCompletedItems);
  }
  return nextSettings;
}
function normalizeGeneralSettings(settings) {
  const maxCompletedItems = Number(settings?.maxCompletedItems);
  return {
    ...DEFAULT_GENERAL_SETTINGS,
    keepCompletedItems: Boolean(settings?.keepCompletedItems),
    maxCompletedItems: ALLOWED_COMPLETED_RECORD_COUNTS.includes(maxCompletedItems)
      ? maxCompletedItems
      : DEFAULT_GENERAL_SETTINGS.maxCompletedItems,
    endpointUrl: normalizeEndpointUrl(settings?.endpointUrl || ""),
    endpointSetupUrl: normalizeSetupUrl(settings?.endpointSetupUrl || settings?.endpointUrl || ""),
    endpointKey: String(settings?.endpointKey || "").trim()
  };
}
/** Save a remote forward endpoint URL and API key to settings. */
async function saveForwardEndpoint(endpointUrl, endpointKey = "", endpointSetupUrl = "") {
  const currentSettings = await getGeneralSettings();
  const nextSettings = normalizeGeneralSettings({
    ...currentSettings,
    endpointUrl,
    endpointSetupUrl,
    endpointKey
  });
  if (!nextSettings.endpointUrl || !nextSettings.endpointKey) {
    throw new Error(__t("bg_invalidEndpointUrl"));
  }
  await chrome.storage.sync.set({ [GENERAL_SETTINGS_KEY]: nextSettings });
  return nextSettings;
}
/** Initiate a forward endpoint binding flow with a confirm dialog. */
async function requestForwardEndpointBinding(endpointUrl, endpointKey, endpointSetupUrl, sender, sendResponse) {
  const normalizedEndpointUrl = normalizeEndpointUrl(endpointUrl);
  if (!normalizedEndpointUrl) {
    throw new Error(__t("bg_missingEndpointUrl"));
  }
  const normalizedEndpointKey = String(endpointKey || "").trim();
  if (!normalizedEndpointKey) {
    throw new Error(__t("bg_missingEndpointKey"));
  }
  const requestId = `endpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const senderUrl = String(sender?.url || "");
  const binding = {
    requestId,
    endpointUrl: normalizedEndpointUrl,
    endpointSetupUrl: normalizeSetupUrl(endpointSetupUrl) || normalizedEndpointUrl,
    endpointKey: normalizedEndpointKey,
    senderUrl,
    senderOrigin: getUrlOrigin(senderUrl),
    requestedAt: Date.now(),
    sendResponse,
    timeoutId: null,
    windowId: null
  };
  binding.timeoutId = setTimeout(() => {
    rejectForwardEndpointBinding(requestId, __t("bg_bindingTimeout")).catch(() => { });
  }, FORWARD_ENDPOINT_BINDING_TIMEOUT_MS);
  pendingForwardEndpointBindings.set(requestId, binding);
  try {
    const popup = await chrome.windows.create({
      url: chrome.runtime.getURL(`confirm/index.html?requestId=${encodeURIComponent(requestId)}`),
      type: "popup",
      width: 420,
      height: 350,
      focused: true
    });
    binding.windowId = popup?.id || null;
  } catch (error) {
    pendingForwardEndpointBindings.delete(requestId);
    clearTimeout(binding.timeoutId);
    throw error;
  }
}
async function getPendingForwardEndpointBinding(requestId) {
  const binding = pendingForwardEndpointBindings.get(String(requestId || ""));
  if (!binding) {
    throw new Error(__t("bg_bindingExpired"));
  }
  return {
    requestId: binding.requestId,
    endpointUrl: binding.endpointUrl,
    senderUrl: binding.senderUrl,
    senderOrigin: binding.senderOrigin,
    requestedAt: binding.requestedAt
  };
}
async function approveForwardEndpointBinding(requestId) {
  const binding = pendingForwardEndpointBindings.get(String(requestId || ""));
  if (!binding) {
    throw new Error(__t("bg_bindingExpired"));
  }
  pendingForwardEndpointBindings.delete(binding.requestId);
  clearTimeout(binding.timeoutId);
  try {
    const settings = await saveForwardEndpoint(binding.endpointUrl, binding.endpointKey, binding.endpointSetupUrl);
    binding.sendResponse({ ok: true, result: settings });
    return settings;
  } catch (error) {
    binding.sendResponse({ ok: false, error: error.message || String(error) });
    throw error;
  }
}
async function rejectForwardEndpointBinding(requestId, reason = __t("bg_bindingRejected")) {
  const binding = pendingForwardEndpointBindings.get(String(requestId || ""));
  if (!binding) {
    return;
  }
  pendingForwardEndpointBindings.delete(binding.requestId);
  clearTimeout(binding.timeoutId);
  binding.sendResponse({ ok: false, error: reason });
}
async function clearForwardEndpoint() {
  const currentSettings = await getGeneralSettings();
  const nextSettings = normalizeGeneralSettings({
    ...currentSettings,
    endpointUrl: "",
    endpointSetupUrl: "",
    endpointKey: ""
  });
  await chrome.storage.sync.set({ [GENERAL_SETTINGS_KEY]: nextSettings });
  return nextSettings;
}
async function exportSettings() {
  const [settings, telegramConfigs, localSettings] = await Promise.all([
    getGeneralSettings(),
    getTelegramConfigs(),
    chrome.storage.local.get(UI_LANGUAGE_KEY)
  ]);
  return {
    schema: "save2telegram-settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    uiLanguage: normalizeUiLanguage(localSettings[UI_LANGUAGE_KEY]),
    generalSettings: settings,
    telegramConfigs
  };
}
async function importSettings(backup) {
  if (!backup || typeof backup !== "object") {
    throw new Error(__t("bg_invalidSettingsBackup"));
  }
  const hasRecognizedSettings = Object.prototype.hasOwnProperty.call(backup, "generalSettings") ||
    Object.prototype.hasOwnProperty.call(backup, "settings") ||
    Object.prototype.hasOwnProperty.call(backup, "telegramConfigs") ||
    Object.prototype.hasOwnProperty.call(backup, "configs") ||
    Object.prototype.hasOwnProperty.call(backup, "uiLanguage");
  if (!hasRecognizedSettings) {
    throw new Error(__t("bg_invalidSettingsBackup"));
  }
  const hasConfigs = Object.prototype.hasOwnProperty.call(backup, "telegramConfigs") ||
    Object.prototype.hasOwnProperty.call(backup, "configs");
  const rawConfigs = hasConfigs
    ? Array.isArray(backup.telegramConfigs)
      ? backup.telegramConfigs
      : Array.isArray(backup.configs)
        ? backup.configs
        : []
    : await getTelegramConfigs();
  const nextConfigs = normalizeTelegramConfigs(rawConfigs);
  const rawSettings = backup.generalSettings || backup.settings || await getGeneralSettings();
  const nextSettings = normalizeGeneralSettings(rawSettings);
  const localSettings = Object.prototype.hasOwnProperty.call(backup, "uiLanguage")
    ? { [UI_LANGUAGE_KEY]: backup.uiLanguage }
    : await chrome.storage.local.get(UI_LANGUAGE_KEY);
  const uiLanguage = normalizeUiLanguage(localSettings[UI_LANGUAGE_KEY]);
  await Promise.all([
    chrome.storage.sync.set({ [GENERAL_SETTINGS_KEY]: nextSettings }),
    chrome.storage.local.set({ [UI_LANGUAGE_KEY]: uiLanguage }),
    writeTelegramConfigs(nextConfigs)
  ]);
  if (!nextSettings.keepCompletedItems) {
    await clearCompletedQueueItems();
  } else {
    await trimCompletedQueueItems(nextSettings.maxCompletedItems);
  }
  return {
    settings: nextSettings,
    uiLanguage,
    configs: nextConfigs.map(sanitizeTelegramConfig)
  };
}
function normalizeUiLanguage(value) {
  const language = String(value || "auto").trim();
  return ["auto", "en", "zh_CN"].includes(language) ? language : "auto";
}
/** Normalize an endpoint URL: ensure protocol, strip trailing slash. */
function normalizeEndpointUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}
function getUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (_) {
    return "";
  }
}
async function reorderTelegramConfigs(ids) {
  const orderedIds = Array.isArray(ids) ? ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const configs = await getTelegramConfigs();
  if (!orderedIds.length) {
    return configs;
  }
  const configsById = new Map(configs.map((config) => [config.id, config]));
  const nextConfigs = [
    ...orderedIds.map((id) => configsById.get(id)).filter(Boolean),
    ...configs.filter((config) => !orderedIds.includes(config.id))
  ];
  await writeTelegramConfigs(nextConfigs);
  return nextConfigs;
}
async function touchTelegramConfig(id) {
  const configId = String(id || "").trim();
  if (!configId) {
    return;
  }
  const configs = await getTelegramConfigs();
  const nextConfigs = configs.map((entry) => (
    entry.id === configId ? { ...entry, lastUsedAt: Date.now(), updatedAt: Date.now() } : entry
  ));
  await writeTelegramConfigs(nextConfigs);
}
async function getTelegramConfigForSend(id = "") {
  const configs = await getTelegramConfigs();
  if (!configs.length) {
    throw new Error(__t("bg_configureFirst"));
  }
  const configId = String(id || "").trim();
  const selected = configId ? configs.find((entry) => entry.id === configId) : null;
  const fallback = configs[0];
  const config = selected || fallback;
  if (!config?.botToken || !config?.chatId) {
    throw new Error(__t("bg_configIncomplete"));
  }
  return config;
}
function normalizeTelegramConfigs(configs) {
  if (!Array.isArray(configs)) {
    return [];
  }
  return configs
    .map((config) => ({
      id: String(config?.id || "").trim() || createTelegramConfigId(),
      note: String(config?.note || "").trim(),
      botToken: String(config?.botToken || "").trim(),
      chatId: String(config?.chatId || "").trim(),
      createdAt: Number(config?.createdAt || Date.now()),
      updatedAt: Number(config?.updatedAt || 0),
      lastUsedAt: Number(config?.lastUsedAt || 0)
    }))
    .filter((config) => config.note && config.botToken && config.chatId);
}
async function writeTelegramConfigs(configs) {
  await chrome.storage.sync.set({ [TELEGRAM_CONFIGS_KEY]: normalizeTelegramConfigs(configs) });
  await chrome.storage.sync.remove(["botToken", "chatId"]);
}
function sanitizeTelegramConfig(config) {
  return {
    id: config.id,
    note: config.note,
    chatId: config.chatId,
    tokenTail: config.botToken ? config.botToken.slice(-6) : "",
    createdAt: config.createdAt || 0,
    updatedAt: config.updatedAt || 0,
    lastUsedAt: config.lastUsedAt || 0,
    label: getTelegramConfigLabel(config)
  };
}
/** Get a human-readable label for a Telegram config. */
function getTelegramConfigLabel(config) {
  return config.note || config.chatId || __t("bg_unnamedConfig");
}
function getTelegramChatKey(config) {
  const chatId = String(config?.chatId || "").trim();
  return chatId ? `chat:${chatId}` : "";
}
function getQueueItemChatKey(item) {
  return String(item?.telegramChatKey || "").trim() ||
    (item?.telegramConfigId ? `config:${item.telegramConfigId}` : "");
}
function getQueueChatCooldownUntil(queue, chatKey, now = Date.now()) {
  if (!chatKey) {
    return 0;
  }
  return queue.reduce((until, item) => {
    if (getQueueItemChatKey(item) !== chatKey) {
      return until;
    }
    const retryAfterUntil = Number(item.retryAfterUntil || 0);
    return retryAfterUntil > now ? Math.max(until, retryAfterUntil) : until;
  }, 0);
}
function getFloodControlRetryMessage(retryAfterUntil, now = Date.now()) {
  const waitSeconds = Math.max(1, Math.ceil((Number(retryAfterUntil || 0) - now) / 1000));
  return `Telegram flood control: retry manually after ${waitSeconds}s`;
}
function createTelegramConfigId() {
  return `tg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function rememberCapturedGraphqlRequest(tabId, url, requestHeaders) {
  const headers = sanitizeGraphqlHeaders(requestHeaders);
  if (!headers.authorization || !headers["x-csrf-token"]) {
    return;
  }

  const requests = capturedGraphqlRequestsByTab.get(tabId) || [];
  const nextRequests = requests.filter((candidate) => candidate.url !== url);
  nextRequests.push({ url, headers });
  while (nextRequests.length > MAX_CAPTURED_GRAPHQL_URLS_PER_TAB) {
    nextRequests.shift();
  }
  capturedGraphqlRequestsByTab.set(tabId, nextRequests);
}
function sanitizeGraphqlHeaders(requestHeaders) {
  const allowedHeaders = new Set([
    "authorization",
    "content-type",
    "x-csrf-token",
    "x-twitter-active-user",
    "x-twitter-auth-type",
    "x-twitter-client-language"
  ]);
  return (Array.isArray(requestHeaders) ? requestHeaders : [])
    .reduce((headers, header) => {
      const name = String(header?.name || "").toLowerCase();
      const value = typeof header?.value === "string" ? header.value : "";
      if (allowedHeaders.has(name) && value) {
        headers[name] = value;
      }
      return headers;
    }, {});
}
function isTweetGraphqlUrl(url) {
  if (typeof url !== "string" || !url.includes("/i/api/graphql/")) {
    return false;
  }

  return isDirectTweetGraphqlOperation(getGraphqlOperationName(url));
}
function getGraphqlOperationName(url) {
  try {
    return new URL(url).pathname.match(/\/i\/api\/graphql\/[^/]+\/([^/?#]+)/)?.[1] || "";
  } catch {
    return "";
  }
}
function isDirectTweetGraphqlOperation(operationName) {
  return operationName === "TweetResultByRestId" || operationName === "TweetDetail";
}
