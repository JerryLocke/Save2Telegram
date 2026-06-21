importScripts('lib/i18n.js');
(function () {
  var __i18nReady = false;
  Save2TG.I18n.init().then(function () { __i18nReady = true; }).catch(function () { __i18nReady = true; });
  function __t(key, subs) { return __i18nReady ? Save2TG.I18n.t(key, subs) : key; }
  const TELEGRAM_API_BASE = "https://api.telegram.org";
  const QUEUE_KEY = "forwardQueue";
  const DRAFT_KEY = "forwardDraft";
  const TELEGRAM_CONFIGS_KEY = "telegramConfigs";
  const GENERAL_SETTINGS_KEY = "generalSettings";
  const UI_LANGUAGE_KEY = "uiLanguage";
  const DEFAULT_GENERAL_SETTINGS = {
    keepCompletedItems: false,
    maxCompletedItems: 5,
    endpointUrl: "",
    endpointSetupUrl: "",
    endpointKey: ""
  };
  const ALLOWED_COMPLETED_RECORD_COUNTS = [5, 10, 30];
  const VIDEO_HOST_PATTERN = /^https:\/\/video\.twimg\.com\//;
  const TELEGRAM_MEDIA_GROUP_MAX_ITEMS = 10;
  const TELEGRAM_PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
  const TELEGRAM_FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
  const MAX_CAPTURED_GRAPHQL_URLS_PER_TAB = 20;
  const TELEGRAM_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
  const TELEGRAM_SEND_MIN_INTERVAL_MS = 1250;
  const FORWARD_ENDPOINT_BINDING_TIMEOUT_MS = 2 * 60 * 1000;
  const MAX_CONCURRENT_FORWARD_TASKS = 3;
  let queueProcessingPromise = null;
  let queueUpdatePromise = Promise.resolve();
  const activeQueueItemIds = new Set();
  const activeQueueChatKeys = new Set();
  const activeQueueAbortControllers = new Map();
  const telegramSendQueuesByChat = new Map();
  const telegramLastSendAtByChat = new Map();
  const capturedGraphqlRequestsByTab = new Map();
  const pendingForwardEndpointBindings = new Map();
  // ==================== Architecture ====================
  // Popup/UI  --chrome.runtime.sendMessage--> Service Worker (SW)
  // SW (LocalForwardEndpoint)  --direct--> Telegram API
  // SW (RemoteForwardEndpoint) --SSE------> Backend /api/forward  (real-time progress)
  //     After SSE stream drops:    --poll----> Backend /api/forward-jobs/:id
  // SW always writes progress to chrome.storage (forwardQueue)
  // Popup reads queue from chrome.storage via GET_FORWARD_QUEUE, unaware of local/remote difference
  // ================================================================
  if (chrome.webRequest?.onBeforeSendHeaders) {
    chrome.webRequest.onBeforeSendHeaders?.addListener(
      (details) => {
        if (details.tabId < 0 || !isTweetGraphqlUrl(details.url)) {
          return;
        }
        rememberCapturedGraphqlRequest(details.tabId, details.url, details.requestHeaders || []);
      },
      { urls: ["https://x.com/i/api/graphql/*", "https://twitter.com/i/api/graphql/*"] },
      ["requestHeaders", "extraHeaders"]
    );
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_CAPTURED_TWEET_GRAPHQL_REQUESTS") {
      const tabId = _sender?.tab?.id;
      const capturedRequests = Number.isInteger(tabId) ? (capturedGraphqlRequestsByTab.get(tabId) || []) : [];
      sendResponse({ ok: true, result: capturedRequests });
      return false;
    }
    if (message?.type === "FORWARD_TWITTER_MEDIA") {
      enqueueForward(message.payload, _sender, message.configId)
        .then((item) => sendResponse({ ok: true, result: item }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "GET_FORWARD_DRAFT") {
      getPublicForwardDraft()
        .then((draft) => sendResponse({ ok: true, result: draft }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "TOGGLE_FORWARD_DRAFT_MEDIA") {
      toggleForwardDraftMedia(message.payload, message.configId, message.sourceKey, { preferConfig: message.preferConfig })
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "SEND_FORWARD_DRAFT") {
      sendForwardDraft(message.payload, _sender, message.configId, message.sourceKey, { preferConfig: message.preferConfig })
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "CLEAR_FORWARD_DRAFT") {
      clearForwardDraft()
        .then(() => sendResponse({ ok: true, result: null }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "GET_TELEGRAM_CONFIGS") {
      getTelegramConfigs()
        .then((configs) => sendResponse({ ok: true, result: configs.map(sanitizeTelegramConfig) }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "SAVE_TELEGRAM_CONFIG") {
      saveTelegramConfig(message.config)
        .then((configs) => sendResponse({ ok: true, result: configs.map(sanitizeTelegramConfig) }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "DELETE_TELEGRAM_CONFIG") {
      deleteTelegramConfig(message.id)
        .then((configs) => sendResponse({ ok: true, result: configs.map(sanitizeTelegramConfig) }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "REORDER_TELEGRAM_CONFIGS") {
      reorderTelegramConfigs(message.ids)
        .then((configs) => sendResponse({ ok: true, result: configs.map(sanitizeTelegramConfig) }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "GET_GENERAL_SETTINGS") {
      getGeneralSettings()
        .then((settings) => sendResponse({ ok: true, result: settings }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "SAVE_GENERAL_SETTINGS") {
      saveGeneralSettings(message.settings)
        .then(async (settings) => sendResponse({
          ok: true,
          result: settings,
          queue: await getVisibleQueue()
        }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "CLEAR_FORWARD_ENDPOINT") {
      clearForwardEndpoint()
        .then(async (settings) => sendResponse({
          ok: true,
          result: settings,
          queue: await getVisibleQueue()
        }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "EXPORT_SETTINGS") {
      exportSettings()
        .then((backup) => sendResponse({ ok: true, result: backup }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "IMPORT_SETTINGS") {
      importSettings(message.backup)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "GET_FORWARD_QUEUE") {
      processQueue();
      getVisibleQueue()
        .then((queue) => sendResponse({ ok: true, result: queue }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "GET_PENDING_FORWARD_ENDPOINT_BINDING") {
      getPendingForwardEndpointBinding(message.requestId)
        .then((binding) => sendResponse({ ok: true, result: binding }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "APPROVE_FORWARD_ENDPOINT_BINDING") {
      approveForwardEndpointBinding(message.requestId)
        .then((settings) => sendResponse({ ok: true, result: settings }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "REJECT_FORWARD_ENDPOINT_BINDING") {
      rejectForwardEndpointBinding(message.requestId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "RETRY_FORWARD_QUEUE_ITEM") {
      retryQueueItem(message.id)
        .then((queue) => sendResponse({ ok: true, result: queue }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "REMOVE_FORWARD_QUEUE_ITEM") {
      removeQueueItem(message.id)
        .then((queue) => sendResponse({ ok: true, result: queue }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "CANCEL_FORWARD_QUEUE_ITEM") {
      cancelForwardQueueItem(message.id)
        .then((queue) => sendResponse({ ok: true, result: queue }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    return false;
  });
  chrome.runtime.onMessageExternal?.addListener((message, sender, sendResponse) => {
    if (message?.type !== "SET_FORWARD_ENDPOINT") {
      return false;
    }
    requestForwardEndpointBinding(message.endpointUrl || sender?.url || "", message.key || "", message.setupUrl || sender?.url || "", sender, sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });
  chrome.windows?.onRemoved?.addListener((windowId) => {
    for (const [requestId, binding] of pendingForwardEndpointBindings.entries()) {
      if (binding.windowId === windowId) {
        rejectForwardEndpointBinding(requestId, __t("bg_bindingCancelled")).catch(() => { });
        break;
      }
    }
  });
  chrome.runtime.onStartup?.addListener(() => {
    refreshQueueBadge();
    processQueue();
  });
  chrome.runtime.onInstalled?.addListener(() => {
    refreshQueueBadge();
    processQueue();
  });
  /** Add a tweet to the forward queue and start processing. */
  async function enqueueForward(payload, sender, configId = "", options = {}) {
    if (!payload?.tweetUrl) {
      throw new Error(__t("bg_noTweetUrl"));
    }
    assertForwardablePayload(payload);
    const config = await getTelegramConfigForSend(configId);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      status: "pending",
      payload,
      telegramConfigId: config.id,
      telegramConfigLabel: getTelegramConfigLabel(config),
      telegramChatKey: getTelegramChatKey(config),
      attempts: 0,
      progress: 0,
      phaseProgress: 0,
      phase: "pending",
      bytesLoaded: 0,
      bytesTotal: 0,
      lastError: "",
      debugLog: [createDebugLogEntry("Queued")],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await updateQueue((queue) => {
      if (options.force) {
        return [...queue, item];
      }

      const existing = queue.find((entry) => entry.payload?.tweetUrl === payload.tweetUrl &&
        entry.telegramConfigId === config.id &&
        entry.status !== "error" &&
        entry.status !== "sent");
      return existing ? queue : [...queue, item];
    });
    await touchTelegramConfig(config.id);
    processQueue();
    return item;
  }

  async function getForwardDraft() {
    const data = await chrome.storage.local.get(DRAFT_KEY);
    return normalizeForwardDraft(data[DRAFT_KEY]);
  }

  async function getPublicForwardDraft() {
    return serializeForwardDraft(await getForwardDraft());
  }

  async function writeForwardDraft(draft) {
    const normalized = normalizeForwardDraft(draft);
    if (!normalized) {
      await clearForwardDraft();
      return null;
    }

    await chrome.storage.local.set({ [DRAFT_KEY]: normalized });
    return normalized;
  }

  async function clearForwardDraft() {
    await chrome.storage.local.remove(DRAFT_KEY);
    return null;
  }

  async function toggleForwardDraftMedia(payload, configId = "", sourceKey = "", options = {}) {
    const currentDraft = await getForwardDraft();
    const entries = createDraftEntries(payload, sourceKey);
    if (!entries.length) {
      throw new Error(__t("bg_noDraftMedia"));
    }

    const normalizedSourceKey = entries[0].sourceKey;
    const hasSource = currentDraft?.items?.some((item) => item.sourceKey === normalizedSourceKey);
    if (hasSource) {
      const nextItems = currentDraft.items.filter((item) => item.sourceKey !== normalizedSourceKey);
      if (!nextItems.length) {
        await clearForwardDraft();
        return { action: "removed", draft: null };
      }

      const nextDraft = await writeForwardDraft({
        ...currentDraft,
        items: nextItems,
        updatedAt: Date.now()
      });
      return { action: "removed", draft: serializeForwardDraft(nextDraft) };
    }

    const config = await resolveDraftConfig(currentDraft, configId, options);
    const nextItems = mergeDraftEntries(currentDraft?.items || [], entries);
    const now = Date.now();
    const nextDraft = await writeForwardDraft({
      id: currentDraft?.id || createForwardDraftId(),
      version: 1,
      telegramConfigId: config.id,
      telegramConfigLabel: getTelegramConfigLabel(config),
      firstTweet: currentDraft?.firstTweet || entries[0].tweet,
      items: nextItems,
      createdAt: currentDraft?.createdAt || now,
      updatedAt: now
    });

    return { action: "added", draft: serializeForwardDraft(nextDraft) };
  }

  async function sendForwardDraft(payload, sender, configId = "", sourceKey = "", options = {}) {
    const currentDraft = await getForwardDraft();
    const entries = createDraftEntries(payload, sourceKey);
    let draft = currentDraft;

    if (!draft && entries.length) {
      const config = await resolveDraftConfig(null, configId, options);
      const now = Date.now();
      draft = {
        id: createForwardDraftId(),
        version: 1,
        telegramConfigId: config.id,
        telegramConfigLabel: getTelegramConfigLabel(config),
        firstTweet: entries[0].tweet,
        items: entries,
        createdAt: now,
        updatedAt: now
      };
    } else if (draft && entries.length && !draft.items.some((item) => item.sourceKey === entries[0].sourceKey)) {
      const config = await resolveDraftConfig(draft, configId, options);
      draft = {
        ...draft,
        telegramConfigId: config.id,
        telegramConfigLabel: getTelegramConfigLabel(config),
        items: mergeDraftEntries(draft.items, entries),
        updatedAt: Date.now()
      };
    }

    draft = normalizeForwardDraft(draft);
    if (!draft?.items?.length) {
      throw new Error(__t("bg_emptyDraft"));
    }

    await writeForwardDraft(draft);
    const config = await resolveDraftConfig(draft, configId, options);
    const item = await enqueueForward(buildPayloadFromDraft(draft), sender, config.id, { force: true });
    await clearForwardDraft();
    return { item, draft: null };
  }

  async function resolveDraftConfig(currentDraft, configId = "", options = {}) {
    const requestedId = String(configId || "").trim();
    const currentId = String(currentDraft?.telegramConfigId || "").trim();
    const selectedId = options?.preferConfig ? (requestedId || currentId) : (currentId || requestedId);
    return getTelegramConfigForSend(selectedId);
  }

  function createForwardDraftId() {
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function createDraftEntries(payload, sourceKey = "") {
    const tweet = sanitizeDraftTweet(payload);
    const normalizedSourceKey = String(sourceKey || "").trim() || `tweet:${tweet.tweetId || tweet.tweetUrl}`;
    return getPayloadMediaItems(payload)
      .map((media, index) => {
        const sanitizedMedia = sanitizeDraftMedia(media);
        if (!sanitizedMedia) {
          return null;
        }

        return {
          sourceKey: normalizedSourceKey,
          mediaKey: getDraftMediaKey(sanitizedMedia, tweet, index),
          tweet,
          media: sanitizedMedia,
          addedAt: Date.now()
        };
      })
      .filter(Boolean);
  }

  function mergeDraftEntries(existingItems, entries) {
    const seen = new Set((Array.isArray(existingItems) ? existingItems : []).map((item) => item.mediaKey));
    const next = [...(Array.isArray(existingItems) ? existingItems : [])];
    for (const entry of entries) {
      if (seen.has(entry.mediaKey)) {
        continue;
      }

      seen.add(entry.mediaKey);
      next.push(entry);
    }
    return next;
  }

  function normalizeForwardDraft(draft) {
    if (!draft || typeof draft !== "object") {
      return null;
    }

    const items = (Array.isArray(draft.items) ? draft.items : [])
      .map(normalizeDraftItem)
      .filter(Boolean);
    if (!items.length) {
      return null;
    }

    return {
      id: String(draft.id || "").trim() || createForwardDraftId(),
      version: 1,
      telegramConfigId: String(draft.telegramConfigId || "").trim(),
      telegramConfigLabel: String(draft.telegramConfigLabel || "").trim(),
      firstTweet: sanitizeDraftTweet(draft.firstTweet || items[0].tweet),
      items,
      createdAt: Number(draft.createdAt || Date.now()),
      updatedAt: Number(draft.updatedAt || Date.now())
    };
  }

  function normalizeDraftItem(item) {
    const media = sanitizeDraftMedia(item?.media);
    if (!media) {
      return null;
    }

    const tweet = sanitizeDraftTweet(item?.tweet);
    const sourceKey = String(item?.sourceKey || "").trim() || `tweet:${tweet.tweetId || tweet.tweetUrl}`;
    return {
      sourceKey,
      mediaKey: String(item?.mediaKey || "").trim() || getDraftMediaKey(media, tweet, 0),
      tweet,
      media,
      addedAt: Number(item?.addedAt || Date.now())
    };
  }

  function sanitizeDraftTweet(value) {
    const tweetUrl = String(value?.tweetUrl || "").trim();
    return {
      tweetUrl,
      tweetId: String(value?.tweetId || getTweetIdFromUrl(tweetUrl)).trim(),
      author: String(value?.author || "").trim(),
      text: String(value?.text || "").trim()
    };
  }

  function sanitizeDraftMedia(media) {
    const type = media?.type === "video" ? "video" : (media?.type === "photo" ? "photo" : "");
    if (!type) {
      return null;
    }

    const candidates = Array.isArray(media?.candidates)
      ? media.candidates.map((url) => String(url || "").trim()).filter(Boolean).slice(0, 8)
      : [];
    const url = String(media?.url || candidates[0] || "").trim();
    const thumbnail = String(media?.thumbnail || "").trim();

    if (type === "photo" && !url) {
      return null;
    }
    if (type === "video" && !url && !candidates.length) {
      return null;
    }

    return {
      type,
      url,
      thumbnail,
      sourceId: String(media?.sourceId || "").trim(),
      candidates
    };
  }

  function getDraftMediaKey(media, tweet, index) {
    const identity = media.type === "video"
      ? (media.sourceId || media.url || media.candidates?.[0] || "")
      : (media.url || media.thumbnail || "");
    return `${media.type}:${identity || `${tweet.tweetId || tweet.tweetUrl}:${index}`}`;
  }

  function serializeForwardDraft(draft) {
    const normalized = normalizeForwardDraft(draft);
    if (!normalized) {
      return null;
    }

    const mediaItems = normalized.items.map((item) => item.media);
    const counts = getDraftMediaCounts(mediaItems);
    return {
      ...normalized,
      mediaItems,
      count: mediaItems.length,
      photoCount: counts.photoCount,
      videoCount: counts.videoCount
    };
  }

  function getDraftMediaCounts(mediaItems) {
    return {
      photoCount: mediaItems.filter((media) => media.type === "photo").length,
      videoCount: mediaItems.filter((media) => media.type === "video").length
    };
  }

  function buildPayloadFromDraft(draft) {
    const mediaItems = draft.items.map((item) => ({
      ...item.media,
      draftMediaKey: item.mediaKey,
      draftSourceKey: item.sourceKey
    }));
    const firstTweet = draft.firstTweet || draft.items[0]?.tweet || {};
    return {
      tweetUrl: firstTweet.tweetUrl || "",
      tweetId: firstTweet.tweetId || getTweetIdFromUrl(firstTweet.tweetUrl || ""),
      author: firstTweet.author || "",
      text: firstTweet.text || "",
      media: mediaItems[0] || null,
      mediaItems,
      originalMediaItems: mediaItems,
      batchDraftId: draft.id,
      sourceTweetUrls: [...new Set(draft.items.map((item) => item.tweet?.tweetUrl).filter(Boolean))]
    };
  }

  function getTweetIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/status\/(\d+)/)?.[1] || "";
    } catch {
      return "";
    }
  }

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
        url: chrome.runtime.getURL(`confirm.html?requestId=${encodeURIComponent(requestId)}`),
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
  /** Reset a failed queue item to pending and retry. */
  async function retryQueueItem(id) {
    if (!id) {
      throw new Error("Missing queue item ID.");
    }
    const queue = await getQueue();
    const currentItem = queue.find((item) => item.id === id);
    const retryAfterUntil = Number(currentItem?.retryAfterUntil || 0);
    if (retryAfterUntil > Date.now()) {
      // Fail fast for manual retry during Telegram flood-control cooldown:
      // keep the popup list intact and surface the wait time only via tooltip.
      const message = getFloodControlRetryMessage(retryAfterUntil);
      await markQueueItem(id, {
        lastError: message,
        updatedAt: Date.now()
      });
      return getVisibleQueue();
    }
    await updateQueue((queue) => queue.map((item) => {
      if (item.id !== id) {
        return item;
      }
      return {
        ...item,
        status: "pending",
        phase: "pending",
        progress: 0,
        phaseProgress: 0,
        lastError: "",
        retryAfterUntil: 0,
        retryNotBefore: 0,
        remoteJobId: "",
        updatedAt: Date.now()
      };
    }));
    processQueue();
    return getVisibleQueue();
  }
  /** Remove a queue item by ID. */
  async function removeQueueItem(id) {
    activeQueueAbortControllers.get(id)?.abort();
    await updateQueue((queue) => queue.filter((item) => item.id !== id));
    return getVisibleQueue();
  }
  /** Cancel a queued forward: remove from queue and notify remote endpoint if applicable. */
  async function cancelForwardQueueItem(id) {
    if (!id) throw new Error("Missing queue item ID.");
    activeQueueAbortControllers.get(id)?.abort();
    const queue = await getQueue();
    const item = queue.find(i => i.id === id);
    const remoteJobId = item?.remoteJobId;
    if (remoteJobId) {
      const settings = await getGeneralSettings();
      if (settings.endpointUrl) {
        try {
          await fetch(`${settings.endpointUrl}/api/forward-jobs/${encodeURIComponent(remoteJobId)}`, {
            method: "DELETE",
            headers: getEndpointAuthHeaders(settings)
          });
        } catch (_) { }
      }
    }
    await updateQueue((q) => q.filter((entry) => entry.id !== id));
    return getVisibleQueue();
  }
  /** Ensure the queue scheduler is running (singleton). */
  async function processQueue() {
    if (queueProcessingPromise) {
      return queueProcessingPromise;
    }
    queueProcessingPromise = drainQueue().finally(() => {
      queueProcessingPromise = null;
    });
    return queueProcessingPromise;
  }
  function normalizeSetupUrl(value) {
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
      return url.toString();
    } catch (_) {
      return "";
    }
  }
  /** Start pending queue items up to the configured concurrency limit. */
  async function drainQueue() {
    if (!activeQueueItemIds.size) {
      await updateQueue((queue) => queue.map((item) => (
        item.status === "sending" ? { ...item, status: "pending", updatedAt: Date.now() } : item
      )));
    }

    while (activeQueueItemIds.size < MAX_CONCURRENT_FORWARD_TASKS) {
      const queue = await failCooldownBlockedPendingQueueItems();
      const item = findNextRunnableQueueItem(queue);
      if (!item) {
        break;
      }
      activeQueueItemIds.add(item.id);
      const chatKey = getQueueItemChatKey(item);
      if (chatKey) {
        activeQueueChatKeys.add(chatKey);
      }
      runQueueItem(item)
        .catch((error) => debugError(item.id, "Queue item runner failed", error))
        .finally(() => {
          activeQueueItemIds.delete(item.id);
          if (chatKey) {
            activeQueueChatKeys.delete(chatKey);
          }
          processQueue();
        });
    }
  }
  async function failCooldownBlockedPendingQueueItems() {
    const now = Date.now();
    const currentQueue = await getQueue();
    if (!hasCooldownBlockedPendingQueueItems(currentQueue, now)) {
      return currentQueue;
    }
    return updateQueue((queue) => {
      let changed = false;
      const nextQueue = queue.map((item) => {
        if (item.status !== "pending") {
          return item;
        }
        const chatKey = getQueueItemChatKey(item);
        const retryAfterUntil = getQueueChatCooldownUntil(queue, chatKey, now);
        if (!chatKey || retryAfterUntil <= now) {
          return item;
        }
        const message = getFloodControlRetryMessage(retryAfterUntil, now);
        changed = true;
        return {
          ...item,
          status: "error",
          phase: item.phase || "pending",
          lastError: message,
          retryAfterUntil,
          retryNotBefore: 0,
          debugLog: appendDebugLog(item.debugLog, `Failed: ${message}`),
          updatedAt: now
        };
      });
      return changed ? nextQueue : queue;
    });
  }
  function hasCooldownBlockedPendingQueueItems(queue, now = Date.now()) {
    return queue.some((item) => {
      if (item.status !== "pending") {
        return false;
      }
      const chatKey = getQueueItemChatKey(item);
      return Boolean(chatKey) && getQueueChatCooldownUntil(queue, chatKey, now) > now;
    });
  }
  function findNextRunnableQueueItem(queue) {
    const now = Date.now();
    return queue.find((entry) => {
      if (entry.status !== "pending" || activeQueueItemIds.has(entry.id)) {
        return false;
      }
      if (Number(entry.retryNotBefore || 0) > now) {
        return false;
      }
      const chatKey = getQueueItemChatKey(entry);
      if (!chatKey) {
        return true;
      }
      return !activeQueueChatKeys.has(chatKey) &&
        getQueueChatCooldownUntil(queue, chatKey, now) <= now;
    });
  }
  /** Process one queue item. Multiple instances may run in parallel. */
  async function runQueueItem(item) {
    const attempt = (item.attempts || 0) + 1;
    const abortController = new AbortController();
    activeQueueAbortControllers.set(item.id, abortController);
    const claimedQueue = await updateQueue((queue) => queue.map((entry) => (
      entry.id === item.id && entry.status === "pending" ? {
        ...entry,
        status: "sending",
        attempts: attempt,
        progress: 0,
        phaseProgress: 0,
        phase: "downloading",
        bytesLoaded: 0,
        bytesTotal: 0,
        lastError: "",
        retryNotBefore: 0,
        debugLog: appendDebugLog(entry.debugLog, `Processing, attempt ${attempt}`),
        updatedAt: Date.now()
      } : entry
    )));
    const claimedItem = claimedQueue.find((entry) => entry.id === item.id);
    if (!claimedItem || claimedItem.status !== "sending" || claimedItem.attempts !== attempt) {
      activeQueueAbortControllers.delete(item.id);
      return;
    }

    try {
      const endpoint = await createForwardEndpoint();
      await endpoint.forward(claimedItem.payload, claimedItem.id, claimedItem.telegramConfigId, {
        signal: abortController.signal
      });
      if (!(await queueHasItem(claimedItem.id))) {
        return;
      }
      debugLog(claimedItem.id, "Queue item sent; marking as sent");
      if ((await getGeneralSettings()).keepCompletedItems) {
        await markQueueItem(claimedItem.id, {
          status: "sent",
          phase: "sent",
          progress: 100,
          phaseProgress: 100,
          lastError: "",
          updatedAt: Date.now()
        });
        await trimCompletedQueueItems((await getGeneralSettings()).maxCompletedItems);
      } else {
        await removeQueueItem(claimedItem.id);
      }
    } catch (error) {
      if (!(await queueHasItem(claimedItem.id))) {
        return;
      }
      debugError(claimedItem.id, "Queue item failed", error);
      const lastError = getQueueErrorMessage(error);
      await appendQueueDebugLog(claimedItem.id, `Failed: ${lastError}`);
      await markQueueItem(claimedItem.id, {
        status: "error",
        lastError,
        retryAfterUntil: getRetryAfterUntil(error),
        updatedAt: Date.now()
      });
    } finally {
      activeQueueAbortControllers.delete(item.id);
    }
  }
  /** Read the full forward queue from chrome.storage.local. */
  async function getQueue() {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
  }
  async function queueHasItem(id) {
    return (await getQueue()).some((item) => item.id === id);
  }
  async function getVisibleQueue() {
    const [queue, settings] = await Promise.all([getQueue(), getGeneralSettings()]);
    return settings.keepCompletedItems ? queue : queue.filter((item) => item.status !== "sent");
  }
  /** Atomically update the queue: read, apply updater function, write back. */
  async function updateQueue(updater) {
    const operation = queueUpdatePromise.catch(() => { }).then(async () => {
      const queue = await getQueue();
      const nextQueue = updater(queue);
      await chrome.storage.local.set({ [QUEUE_KEY]: nextQueue });
      await updateQueueBadge(nextQueue);
      return nextQueue;
    });
    queueUpdatePromise = operation.catch(() => { });
    return operation;
  }
  async function clearCompletedQueueItems() {
    return updateQueue((queue) => queue.filter((item) => item.status !== "sent"));
  }
  /** Trim the number of completed items in the queue to maxCount. */
  async function trimCompletedQueueItems(maxCount) {
    const limit = ALLOWED_COMPLETED_RECORD_COUNTS.includes(Number(maxCount))
      ? Number(maxCount)
      : DEFAULT_GENERAL_SETTINGS.maxCompletedItems;
    return updateQueue((queue) => {
      const completed = queue
        .filter((item) => item.status === "sent")
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const keptCompletedIds = new Set(completed.slice(0, limit).map((item) => item.id));
      return queue.filter((item) => item.status !== "sent" || keptCompletedIds.has(item.id));
    });
  }
  /** Update the extension icon badge with the current queue count. */
  async function refreshQueueBadge() {
    await updateQueueBadge(await getQueue());
  }
  async function updateQueueBadge(queue) {
    const count = queue.filter((item) => item.status !== "sent").length;
    await chrome.action.setBadgeBackgroundColor({ color: "#f04438" });
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
  }
  /** Apply a partial update to a queue item in storage. */
  async function markQueueItem(id, patch) {
    await updateQueue((queue) => queue.map((item) => (
      item.id === id ? { ...item, ...patch } : item
    )));
    if (patch.status === "sent") {
      const settings = await getGeneralSettings();
      if (settings.keepCompletedItems) {
        await trimCompletedQueueItems(settings.maxCompletedItems);
      }
    }
  }
  /** Append a debug log entry to a queue item. */
  async function appendQueueDebugLog(id, message) {
    debugLog(id, message);
    if (!id) {
      return;
    }
    await updateQueue((queue) => queue.map((item) => (
      item.id === id ? { ...item, debugLog: appendDebugLog(item.debugLog, message), updatedAt: Date.now() } : item
    )));
  }
  function appendDebugLog(log = [], message) {
    return [...(Array.isArray(log) ? log : []), createDebugLogEntry(message)].slice(-12);
  }
  /** Create a debug log entry object with timestamp. */
  function createDebugLogEntry(message) {
    return {
      time: Date.now(),
      message
    };
  }
  function debugLog(queueItemId, message, data = undefined) {
    const prefix = queueItemId ? `[Save2Telegram][${queueItemId}]` : "[Save2Telegram]";
    if (data === undefined) {
      console.info(prefix, message);
      return;
    }
    console.info(prefix, message, data);
  }
  function debugError(queueItemId, message, error) {
    const prefix = queueItemId ? `[Save2Telegram][${queueItemId}]` : "[Save2Telegram]";
    console.error(prefix, message, error);
  }
  /** Base class for forward endpoint implementations (local or remote). */
  class ForwardEndpoint {
    constructor(settings) {
      this.settings = settings;
    }
    async forward() {
      throw new Error("ForwardEndpoint.forward must be implemented.");
    }
  }
  /** Forward endpoint that communicates directly with the Telegram Bot API. */
  class LocalForwardEndpoint extends ForwardEndpoint {
    /** Forward tweet media via local Telegram API calls. */
    async forward(payload, queueItemId, configId = "", options = {}) {
      return forwardTwitterMediaLocal(this, payload, queueItemId, configId, options);
    }
    async validateChat(botToken, chatId, signal = null) {
      return validateTelegramChat(botToken, chatId, signal);
    }
    async downloadVideo(payload, queueItemId, progressScope = {}, signal = null) {
      return downloadTwitterVideo(payload, queueItemId, progressScope, signal);
    }
    async downloadPhoto(media, queueItemId, progressScope = {}, signal = null) {
      return downloadTwitterPhoto(media, queueItemId, progressScope, signal);
    }
    async sendPhoto(botToken, chatId, photo, caption, queueItemId = "", signal = null) {
      return sendTelegramPhoto(botToken, chatId, photo, caption, queueItemId, signal);
    }
    async sendPhotoFile(botToken, chatId, photoFile, caption, queueItemId = "", signal = null) {
      return sendTelegramPhotoFile(botToken, chatId, photoFile, caption, queueItemId, signal);
    }
    async sendVideoFile(botToken, chatId, videoFile, caption, queueItemId = "", signal = null) {
      return sendTelegramVideoFile(botToken, chatId, videoFile, caption, queueItemId, signal);
    }
    async sendMessage(botToken, chatId, text, queueItemId = "", signal = null) {
      return sendTelegramMessage(botToken, chatId, text, queueItemId, signal);
    }
    async callMultipart(botToken, method, body, queueItemId = "", signal = null) {
      return callTelegramMultipartLogged(botToken, method, body, queueItemId, signal);
    }
  }
  /** Forward endpoint that communicates via a remote Node.js backend over SSE. */
  class RemoteForwardEndpoint extends ForwardEndpoint {
    /**
       * Forwarding entry point between SW and remote endpoint.
       *
       * Communication path: Popup/UI 鈫愨啋 SW 鈫愨啋 Remote Endpoint
       *   - SW always writes progress to chrome.storage (forwardQueue).
       *   - Popup reads storage only via GET_FORWARD_QUEUE, regardless of local/remote mode.
       *   - Calls POST /api/forward (SSE) only; the first progress event carries the backend-assigned job.id.
       *   - SW persists job.id as remoteJobId in the queue item, can recover after restart.
       *   - After SSE drops, SW falls back to polling GET /api/forward-jobs/:id via job.id.
       *   - Old expired jobs (404) report an error; users can retry from the popup to clear remoteJobId.
       */
    /** Forward tweet media via local Telegram API calls. */
    async forward(payload, queueItemId, configId = "", options = {}) {
      const endpointUrl = this.settings.endpointUrl;
      const config = await getTelegramConfigForSend(configId);
      const caption = buildCaption(payload);
      const mediaItems = getPayloadMediaItems(payload).map(item => ({
        type: item.type,
        url: item.url,
        candidates: item.candidates || [],
        thumbnail: item.thumbnail || '',
        order: item.order || 0,
        draftMediaKey: item.draftMediaKey || "",
        draftSourceKey: item.draftSourceKey || ""
      }));
      const requestBody = {
        payload: { tweetUrl: payload.tweetUrl || "", caption, mediaItems },
        telegram: { botToken: config.botToken, chatId: config.chatId }
      };
      // 1) Check for existing remoteJobId (recovery after SW restart)
      const queue = await getQueue();
      const item = queue.find(i => i.id === queueItemId);
      const existingJobId = item?.remoteJobId;
      if (existingJobId) {
        const resumed = await this._tryResumeJob(endpointUrl, existingJobId, queueItemId, options.signal);
        if (resumed !== null) return resumed;
        // Old job expired -> report error, do not auto-rebuild, user can retry manually in popup
        throw new Error(`Previous job ${existingJobId} has expired. Please retry manually in the popup`);
      }
      // 2) No old job, create new SSE connection
      let jobId = null;
      try {
        jobId = await this._streamWithSse(endpointUrl, requestBody, queueItemId, options.signal);
      } catch (sseError) {
        jobId = sseError.jobId || jobId;
        if (sseError.message === "_SSE_STREAM_ENDED_") {
          if (jobId) {
            await this._pollJob(endpointUrl, jobId, queueItemId, options.signal);
          } else {
            throw new Error("SSE connection lost and unable to retrieve job ID");
          }
        } else {
          throw sseError;
        }
      }
    }
    /** Try to resume an existing backend task. Returns null if expired and needs rebuild */
    async _tryResumeJob(endpointUrl, jobId, queueItemId, signal = null) {
      const res = await fetch(`${endpointUrl}/api/forward-jobs/${encodeURIComponent(jobId)}`, {
        headers: getEndpointAuthHeaders(this.settings),
        signal
      });
      if (res.status === 404) {
        await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
        return null;
      }
      if (!res.ok) {
        throw new Error(`Progress query failed: ${res.status}`);
      }
      const data = await res.json().catch(() => null);
      if (!data?.ok || !data?.job) {
        throw new Error("Progress response malformed");
      }
      const job = data.job;
      await removeSentDraftMediaKeysByQueueItem(queueItemId, job.sentDraftMediaKeys);
      if (job.status === "sent") return job.result;
      if (job.status === "cancelled") {
        await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
        throw createCancelledError();
      }
      if (job.status === "error") {
        await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
        const err = new Error(job.error || "Backend forward failed");
        err.code = job.errorCode || "TELEGRAM_API_ERROR";
        err.retryAfter = Number(job.retryAfter || 0);
        throw err;
      }
      await this._pollJob(endpointUrl, jobId, queueItemId, signal);
      return undefined;
    }
    /** Establish SSE connection via POST /api/forward, read progress events, return backend-assigned job.id */
    async _streamWithSse(endpointUrl, requestBody, queueItemId, signal = null) {
      const response = await fetch(`${endpointUrl}/api/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getEndpointAuthHeaders(this.settings) },
        body: JSON.stringify(requestBody),
        signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let jobId = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = this._parseSse(buffer);
        buffer = remainder;
        for (const { event, data } of events) {
          if (event === "progress" && data?.id) {
            if (!jobId) {
              jobId = data.id;
              await markQueueItem(queueItemId, { remoteJobId: jobId });
            }
            await removeSentDraftMediaKeysByQueueItem(queueItemId, data.sentDraftMediaKeys);
            await markQueueItem(queueItemId, {
              phase: data.phase || "pending",
              progress: data.progress || 0,
              phaseProgress: data.phaseProgress || 0,
              bytesLoaded: data.bytesLoaded || 0,
              bytesTotal: data.bytesTotal || 0,
              updatedAt: Date.now()
            });
          } else if (event === "result") {
            return jobId;
          } else if (event === "error") {
            await removeSentDraftMediaKeysByQueueItem(queueItemId, data?.sentDraftMediaKeys || data?.job?.sentDraftMediaKeys);
            await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
            const err = new Error(data?.error || "Backend forward failed");
            err.code = data?.code || "TELEGRAM_API_ERROR";
            err.retryAfter = Number(data?.retryAfter || data?.job?.retryAfter || 0);
            throw err;
          }
        }
      }
      const err = new Error("_SSE_STREAM_ENDED_");
      err.jobId = jobId;
      throw err;
    }
    _parseSse(buffer) {
      const events = [];
      const blocks = buffer.split("\n\n");
      const remainder = blocks.pop() || "";
      for (const block of blocks) {
        if (!block.trim()) continue;
        let event = "message";
        let rawData = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) rawData += line.slice(6);
        }
        let data = null;
        try { data = JSON.parse(rawData); } catch { }
        events.push({ event, data });
      }
      return { events, remainder };
    }
    async _pollJob(endpointUrl, jobId, queueItemId, signal = null) {
      const POLL_INTERVAL_MS = 800;
      const MAX_POLLS = 2250;
      for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(POLL_INTERVAL_MS, signal);
        const res = await fetch(`${endpointUrl}/api/forward-jobs/${encodeURIComponent(jobId)}`, {
          headers: getEndpointAuthHeaders(this.settings),
          signal
        });
        if (!res.ok) throw new Error(`Progress query failed: ${res.status}`);
        const data = await res.json().catch(() => null);
        if (!data?.ok || !data?.job) throw new Error("Progress response malformed");
        const job = data.job;
        await removeSentDraftMediaKeysByQueueItem(queueItemId, job.sentDraftMediaKeys);
        await markQueueItem(queueItemId, {
          phase: job.phase || "pending",
          progress: job.progress || 0,
          phaseProgress: job.phaseProgress || 0,
          bytesLoaded: job.bytesLoaded || 0,
          bytesTotal: job.bytesTotal || 0,
          updatedAt: Date.now()
        });
        if (job.status === "sent") return job.result;
        if (job.status === "cancelled") {
          await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
          throw createCancelledError();
        }
        if (job.status === "error") {
          await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
          const err = new Error(job.error || "Backend forward failed");
          err.code = job.errorCode || "TELEGRAM_API_ERROR";
          err.retryAfter = Number(job.retryAfter || 0);
          throw err;
        }
      }
      throw new Error(`Job ${jobId} timed out (30 min). You can query it by this ID on the backend`);
    }
  }
  /** Factory: create the appropriate ForwardEndpoint based on current settings. */
  async function createForwardEndpoint() {
    const settings = await getGeneralSettings();
    return settings.endpointUrl && settings.endpointKey
      ? new RemoteForwardEndpoint(settings)
      : new LocalForwardEndpoint(settings);
  }
  /** Build authorization headers for a remote endpoint request. */
  function getEndpointAuthHeaders(settings) {
    const key = String(settings?.endpointKey || "").trim();
    return key ? { "Authorization": `Bearer ${key}` } : {};
  }
  /** Forward tweet media through a local endpoint, handling photos, videos, and media groups. */
  async function forwardTwitterMediaLocal(endpoint, payload, queueItemId, configId = "", options = {}) {
    const signal = options?.signal || null;
    const config = await getTelegramConfigForSend(configId);
    const { botToken, chatId } = config;
    if (!botToken || !chatId) {
      throw new Error(__t("bg_configureFirst"));
    }
    const configLabel = getTelegramConfigLabel(config); try { await endpoint.validateChat(botToken, chatId, signal); } catch (validateError) { throw new Error(`Channel "${configLabel}" validation failed: ${validateError.message}`); }
    const tweetUrl = payload?.tweetUrl || "";
    const caption = buildCaption(payload);
    const mediaItems = getPayloadMediaItems(payload);
    await appendQueueDebugLog(queueItemId, `Parsed media: ${mediaItems.length} item(s)`);
    if (!mediaItems.length) {
      await appendQueueDebugLog(queueItemId, "No media, sending text message");
      return endpoint.sendMessage(botToken, chatId, caption || tweetUrl, queueItemId, signal);
    }
    if (mediaItems.length > 1) {
      await appendQueueDebugLog(queueItemId, "Sending media group");
      return forwardTelegramMediaGroup(endpoint, botToken, chatId, payload, mediaItems, caption, queueItemId, signal);
    }
    const media = mediaItems[0];
    if (media?.type === "video") {
      await appendQueueDebugLog(queueItemId, "Downloading video");
      const videoFile = await endpoint.downloadVideo({ ...payload, media }, queueItemId, {
        itemIndex: 0,
        itemTotal: 1
      }, signal);
      assertTelegramUploadSize(videoFile.size || videoFile.blob.size || 0, "video");
      await markTelegramUploadProgress(queueItemId, videoFile);
      const result = await endpoint.sendVideoFile(botToken, chatId, videoFile, caption, queueItemId, signal);
      await removeSentQueueMedia(queueItemId, [media]);
      return result;
    }
    if (!media?.url || media.url.startsWith("blob:")) {
      await appendQueueDebugLog(queueItemId, "Media URL cannot be sent directly, falling back to text message");
      return endpoint.sendMessage(botToken, chatId, caption || tweetUrl, queueItemId, signal);
    }
    await appendQueueDebugLog(queueItemId, "Downloading photo");
    const photoFile = await endpoint.downloadPhoto(media, queueItemId, {
      itemIndex: 0,
      itemTotal: 1
    }, signal);
    assertTelegramUploadSize(photoFile.size || photoFile.blob.size || 0, "photo");
    await markTelegramUploadProgress(queueItemId, photoFile);
    const result = await endpoint.sendPhotoFile(botToken, chatId, photoFile, caption, queueItemId, signal);
    await removeSentQueueMedia(queueItemId, [media]);
    return result;
  }
  /** Extract and filter media items (photo/video) from a tweet payload. */
  function getPayloadMediaItems(payload) {
    const mediaItems = Array.isArray(payload?.mediaItems) ? payload.mediaItems : [];
    const items = mediaItems.length ? mediaItems : (payload?.media ? [payload.media] : []);
    return items.filter((item) => item?.type === "photo" || item?.type === "video");
  }
  function assertForwardablePayload(payload) {
    const mediaItems = getPayloadMediaItems(payload);
    if (!mediaItems.length) {
      throw new Error(__t("bg_noMedia"));
    }

    if (mediaItems.some((media) => media.type === "video" && !hasDownloadableVideoCandidate(media))) {
      throw new Error(__t("bg_noDownloadableVideo"));
    }
  }
  function hasDownloadableVideoCandidate(media) {
    return [
      media?.url,
      ...(Array.isArray(media?.candidates) ? media.candidates : [])
    ]
      .map((url) => typeof url === "string" ? cleanEscapedUrl(url) : "")
      .some((url) => url && !url.startsWith("blob:") && isDownloadableTwitterVideoUrl(url));
  }
  function cleanEscapedUrl(url) {
    return url
      .replaceAll("\\/", "/")
      .replaceAll("&amp;", "&")
      .replace(/\\u0026/g, "&");
  }
  /** Send multiple media items as a Telegram album via the endpoint. */
  async function forwardTelegramMediaGroup(endpoint, botToken, chatId, payload, mediaItems, caption, queueItemId, signal = null) {
    const chunks = sliceMediaGroupChunks(mediaItems);
    const results = [];
    let itemOffset = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunks.length > 1) {
        await appendQueueDebugLog(queueItemId, `Sending media group part ${index + 1}/${chunks.length}`);
      }

      const result = await forwardTelegramMediaGroupChunk(endpoint, botToken, chatId, payload, chunk, index === 0 ? caption : "", queueItemId, signal, {
        itemOffset,
        itemTotal: mediaItems.length
      });
      results.push(result);
      await removeSentQueueMedia(queueItemId, chunk);
      itemOffset += chunk.length;
      await markMediaGroupUploadProgress(queueItemId, itemOffset, mediaItems.length);
    }

    return results;
  }

  async function forwardTelegramMediaGroupChunk(endpoint, botToken, chatId, payload, albumItems, caption, queueItemId, signal = null, progressScope = {}) {
    const form = new FormData();
    const album = [];
    let attachmentIndex = 0;
    const downloadedFiles = [];
    for (let index = 0; index < albumItems.length; index += 1) {
      const item = albumItems[index];
      if (item.type === "photo" && item.url && !item.url.startsWith("blob:")) {
        await appendQueueDebugLog(queueItemId, "Downloading media group photo");
        const photoFile = await endpoint.downloadPhoto(item, queueItemId, {
          itemIndex: Number(progressScope.itemOffset || 0) + index,
          itemTotal: Number(progressScope.itemTotal || albumItems.length)
        }, signal);
        assertTelegramUploadSize(photoFile.size || photoFile.blob.size || 0, "photo");
        downloadedFiles.push(photoFile);
        await markDownloadedFilesSize(queueItemId, downloadedFiles);
        const attachmentName = `media${attachmentIndex}`;
        attachmentIndex += 1;
        form.set(attachmentName, photoFile.blob, photoFile.filename);
        album.push({ type: "photo", media: `attach://${attachmentName}` });
        continue;
      }
      if (item.type === "video") {
        await appendQueueDebugLog(queueItemId, "Downloading media group video");
        const videoFile = await endpoint.downloadVideo({ ...payload, media: item }, queueItemId, {
          itemIndex: Number(progressScope.itemOffset || 0) + index,
          itemTotal: Number(progressScope.itemTotal || albumItems.length)
        }, signal);
        assertTelegramUploadSize(videoFile.size || videoFile.blob.size || 0, "video");
        downloadedFiles.push(videoFile);
        await markDownloadedFilesSize(queueItemId, downloadedFiles);
        const attachmentName = `media${attachmentIndex}`;
        attachmentIndex += 1;
        form.set(attachmentName, videoFile.blob, videoFile.filename);
        album.push({
          type: "video",
          media: `attach://${attachmentName}`,
          supports_streaming: true
        });
      }
    }
    await markMediaGroupUploadProgress(queueItemId, Number(progressScope.itemOffset || 0), Number(progressScope.itemTotal || albumItems.length), downloadedFiles);
    if (!album.length) {
      await appendQueueDebugLog(queueItemId, "Media group empty, falling back to text message");
      return endpoint.sendMessage(botToken, chatId, caption || payload?.tweetUrl || "", queueItemId, signal);
    }
    if (album.length === 1) {
      await appendQueueDebugLog(queueItemId, "Media group has only one item, sending as single media");
      return sendSingleAlbumItem(endpoint, botToken, chatId, album[0], caption, form, queueItemId, signal);
    }
    // Telegram captions albums on individual items; put the tweet caption on the first item only.
    if (caption) {
      album[0].caption = caption;
      album[0].parse_mode = "HTML";
    }
    form.set("chat_id", chatId);
    form.set("media", JSON.stringify(album));
    await appendQueueDebugLog(queueItemId, `Uploading Telegram media group, ${album.length} item(s)`);
    return endpoint.callMultipart(botToken, "sendMediaGroup", form, queueItemId, signal);
  }
  /** Send a single media item that was part of a group, using the appropriate API. */
  async function sendSingleAlbumItem(endpoint, botToken, chatId, item, caption, form, queueItemId, signal = null) {
    const attachName = item.media.replace("attach://", "");
    const file = form.get(attachName);
    if (item.type === "photo") {
      return endpoint.sendPhotoFile(botToken, chatId, {
        blob: file,
        filename: file?.name || "twitter-photo.jpg"
      }, caption, queueItemId, signal);
    }
    return endpoint.sendVideoFile(botToken, chatId, {
      blob: file,
      filename: file?.name || "twitter-video.mp4"
    }, caption, queueItemId, signal);
  }
  function sliceMediaGroupChunks(mediaItems) {
    const chunks = [];
    for (let index = 0; index < mediaItems.length; index += TELEGRAM_MEDIA_GROUP_MAX_ITEMS) {
      chunks.push(mediaItems.slice(index, index + TELEGRAM_MEDIA_GROUP_MAX_ITEMS));
    }
    return chunks;
  }
  async function markMediaGroupUploadProgress(queueItemId, completedItems, totalItems, files = null) {
    if (!queueItemId) {
      return;
    }

    const total = Math.max(1, Number(totalItems || 1));
    const progress = Math.min(100, Math.round((Math.max(0, Number(completedItems || 0)) / total) * 100));
    const size = Array.isArray(files)
      ? files.reduce((sum, file) => sum + (file.size || file.blob?.size || 0), 0)
      : 0;
    await updateQueue((queue) => queue.map((item) => (
      item.id === queueItemId ? {
        ...item,
        progress,
        phaseProgress: progress,
        phase: "uploading",
        bytesLoaded: size || item.bytesLoaded || 0,
        bytesTotal: size || item.bytesTotal || 0,
        updatedAt: Date.now()
      } : item
    )));
  }
  async function removeSentQueueMedia(queueItemId, sentMediaItems) {
    const mediaKeys = (Array.isArray(sentMediaItems) ? sentMediaItems : [])
      .map((media) => String(media?.draftMediaKey || "").trim())
      .filter(Boolean);
    if (!queueItemId || !mediaKeys.length) {
      return;
    }

    const sentKeys = new Set(mediaKeys);
    // Drafts are cleared as soon as they enter the queue, so retry state lives
    // on the queue item itself and shrinks after each successful Telegram send.
    await updateQueue((queue) => queue.map((item) => {
      if (item.id !== queueItemId || !item.payload?.batchDraftId) {
        return item;
      }

      const mediaItems = getPayloadMediaItems(item.payload);
      const nextMediaItems = mediaItems.filter((media) => !sentKeys.has(String(media?.draftMediaKey || "").trim()));
      return {
        ...item,
        payload: {
          ...item.payload,
          media: nextMediaItems[0] || null,
          mediaItems: nextMediaItems
        },
        updatedAt: Date.now()
      };
    }));
  }
  async function removeSentDraftMediaKeysByQueueItem(queueItemId, mediaKeys) {
    const keys = (Array.isArray(mediaKeys) ? mediaKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean);
    if (!queueItemId || !keys.length) {
      return;
    }

    await removeSentQueueMedia(queueItemId, keys.map((key) => ({ draftMediaKey: key })));
  }
  /** Update queue item state for the upload phase. */
  async function markTelegramUploadProgress(queueItemId, videoFile = null) {
    if (!queueItemId) {
      return;
    }
    const size = Array.isArray(videoFile)
      ? videoFile.reduce((total, file) => total + (file.size || file.blob?.size || 0), 0)
      : (videoFile ? (videoFile.size || videoFile.blob?.size || 0) : 0);
    await updateQueue((queue) => queue.map((item) => (
      item.id === queueItemId ? {
        ...item,
        progress: 0,
        phaseProgress: 0,
        phase: "uploading",
        bytesLoaded: size || item.bytesLoaded || 0,
        bytesTotal: size || item.bytesTotal || 0,
        debugLog: size ? appendDebugLog(item.debugLog, `Downloaded, file size ${formatDebugBytes(size)}`) : item.debugLog,
        updatedAt: Date.now()
      } : item
    )));
  }
  /** Record the total downloaded size for a set of files. */
  async function markDownloadedFilesSize(queueItemId, files) {
    const size = files.reduce((total, file) => total + (file.size || file.blob.size || 0), 0);
    await markQueueItem(queueItemId, {
      bytesLoaded: size,
      bytesTotal: size,
      updatedAt: Date.now()
    });
  }
  /** Download a Twitter video from available candidates, trying each in order. */
  async function downloadTwitterVideo(payload, queueItemId, progressScope = {}, signal = null) {
    throwIfAborted(signal);
    const progress = createDownloadProgressReporter(queueItemId, progressScope);
    const media = payload?.media || {};
    const candidates = normalizeVideoCandidates(media);
    if (!candidates.length) {
      throw new Error(__t("bg_noDownloadableVideo"));
    }
    const errors = [];
    for (const candidate of candidates) {
      try {
        throwIfAborted(signal);
        if (candidate.includes(".m3u8")) {
          return downloadM3u8Video(candidate, queueItemId, progressScope, signal);
        }
        const blob = await fetchVideoBlob(candidate, progress, signal);
        return {
          blob,
          size: blob.size,
          filename: "twitter-video.mp4"
        };
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
          throw createCancelledError();
        }
        errors.push(error.message || String(error));
      }
    }
    throw new Error(__t("bg_videoDownloadFailed", [errors[0] || "No available video source"]));
  }
  async function downloadTwitterPhoto(media, queueItemId, progressScope = {}, signal = null) {
    throwIfAborted(signal);
    const url = typeof media?.url === "string" ? media.url : "";
    if (!url || url.startsWith("blob:")) {
      throw new Error(__t("bg_noDraftMedia"));
    }

    const blob = await fetchBlobWithProgress(url, createDownloadProgressReporter(queueItemId, progressScope), signal, "image/jpeg");
    return {
      blob,
      size: blob.size,
      filename: getPhotoFilename(url, blob.type)
    };
  }
  function createDownloadProgressReporter(queueItemId, progressScope = {}) {
    if (!queueItemId) {
      return null;
    }
    const itemIndex = Math.max(0, Number(progressScope.itemIndex || 0));
    const itemTotal = Math.max(1, Number(progressScope.itemTotal || 1));
    const partIndex = Math.max(0, Number(progressScope.partIndex || 0));
    const partTotal = Math.max(1, Number(progressScope.partTotal || 1));
    let lastUpdateAt = 0;
    return async ({ loaded, total }) => {
      const now = Date.now();
      // Each media item gets an equal slice of the download phase.
      const partRatio = total ? loaded / total : 0;
      const itemRatio = (partIndex + partRatio) / partTotal;
      const progress = total
        ? Math.min(100, Math.round(((itemIndex + itemRatio) / itemTotal) * 100))
        : Math.min(100, Math.round((itemIndex / itemTotal) * 100) + 5);
      if (now - lastUpdateAt < 600 && progress < 100) {
        return;
      }
      lastUpdateAt = now;
      await markQueueItem(queueItemId, {
        phase: "downloading",
        progress,
        phaseProgress: progress,
        bytesLoaded: partTotal > 1 ? 0 : loaded,
        bytesTotal: partTotal > 1 ? 0 : (total || 0),
        updatedAt: now
      });
    };
  }
  /** Extract and deduplicate video source URLs from media metadata. */
  function normalizeVideoCandidates(media) {
    const urls = [
      media.url,
      ...(Array.isArray(media.candidates) ? media.candidates : [])
    ].filter((url) => typeof url === "string" && url && !url.startsWith("blob:"));
    return [...new Set(urls)]
      .filter(isDownloadableTwitterVideoUrl)
      .sort(rankVideoUrlType);
  }
  /** Check if a URL is a downloadable twitter video resource. */
  function isDownloadableTwitterVideoUrl(url) {
    if (typeof url !== "string" || !VIDEO_HOST_PATTERN.test(url)) {
      return false;
    }
    if (url.includes(".m3u8")) {
      return true;
    }
    return url.includes(".mp4") && !isFragmentedMp4InitUrl(url);
  }
  function isFragmentedMp4InitUrl(url) {
    return /\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url);
  }
  function rankVideoUrlType(a, b) {
    const aIsMp4 = a.includes(".mp4") ? 1 : 0;
    const bIsMp4 = b.includes(".mp4") ? 1 : 0;
    return bIsMp4 - aIsMp4;
  }
  function assertTelegramUploadSize(size, mediaType) {
    const limit = mediaType === "photo" ? TELEGRAM_PHOTO_UPLOAD_MAX_BYTES : TELEGRAM_FILE_UPLOAD_MAX_BYTES;
    if (Number(size || 0) > limit) {
      throw new Error(mediaType === "photo" ? __t("bg_photoTooLarge") : __t("bg_videoTooLarge"));
    }
  }
  function getPhotoFilename(url, contentType = "") {
    const extension = contentType.includes("png") ? "png" : (contentType.includes("webp") ? "webp" : "jpg");
    try {
      const pathname = new URL(url).pathname;
      const name = pathname.split("/").filter(Boolean).pop() || "";
      const base = name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "twitter-photo";
      return `${base}.${extension}`;
    } catch {
      return `twitter-photo.${extension}`;
    }
  }
  async function fetchVideoBlob(url, onProgress = null, signal = null) {
    return fetchBlobWithProgress(url, onProgress, signal, "video/mp4");
  }
  async function fetchBlobWithProgress(url, onProgress = null, signal = null, fallbackType = "application/octet-stream") {
    const response = await fetch(url, {
      credentials: "include",
      signal
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const total = Number(response.headers.get("Content-Length") || 0);
    if (!response.body || !onProgress) {
      const blob = await response.blob();
      if (onProgress) {
        await onProgress({ loaded: blob.size, total: total || blob.size });
      }
      return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      loaded += value.byteLength;
      await onProgress({ loaded, total });
    }
    await onProgress({ loaded, total: total || loaded });
    return new Blob(chunks, { type: response.headers.get("Content-Type") || fallbackType });
  }
  /** Download an HLS video stream by concatenating all segments. */
  async function downloadM3u8Video(url, queueItemId = "", progressScope = {}, signal = null) {
    throwIfAborted(signal);
    const playlist = await fetchText(url, signal);
    const audioPlaylistUrl = resolveBestAudioPlaylistUrl(url, playlist);
    const mediaPlaylistUrl = resolveBestPlaylistUrl(url, playlist);
    if (audioPlaylistUrl && mediaPlaylistUrl !== url) {
      throw new Error(__t("bg_hlsSeparateStreams"));
    }
    const mediaPlaylist = mediaPlaylistUrl === url ? playlist : await fetchText(mediaPlaylistUrl, signal);
    const parts = parseMediaPlaylist(mediaPlaylistUrl, mediaPlaylist);
    if (!parts.length) {
      throw new Error(__t("bg_noHlsSegments"));
    }
    const blobs = [];
    for (let index = 0; index < parts.length; index += 1) {
      throwIfAborted(signal);
      const progress = createDownloadProgressReporter(queueItemId, {
        ...progressScope,
        partIndex: index,
        partTotal: parts.length
      });
      blobs.push(await fetchVideoBlob(parts[index], progress, signal));
    }
    const isFragmentedMp4 = parts.some((partUrl) => /\.(m4s|cmfv|mp4)(\?|$)/.test(partUrl));
    return {
      blob: new Blob(blobs, { type: isFragmentedMp4 ? "video/mp4" : "video/mp2t" }),
      filename: isFragmentedMp4 ? "twitter-video.mp4" : "twitter-video.ts"
    };
  }
  /** Find the best audio-only playlist from an HLS master playlist. */
  function resolveBestAudioPlaylistUrl(baseUrl, playlist) {
    const mediaLines = playlist
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(line));
    const audioVariants = mediaLines
      .map((line) => ({
        url: line.match(/URI="([^"]+)"/)?.[1] || "",
        bitrate: Number(line.match(/GROUP-ID="audio-(\d+)"/)?.[1] || 0)
      }))
      .filter((variant) => variant.url);
    if (!audioVariants.length) {
      return "";
    }
    audioVariants.sort((a, b) => b.bitrate - a.bitrate);
    return new URL(audioVariants[0].url, baseUrl).toString();
  }
  async function fetchText(url, signal = null) {
    const response = await fetch(url, {
      credentials: "include",
      signal
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
  }
  /** Find the highest-resolution video playlist from an HLS master playlist. */
  function resolveBestPlaylistUrl(baseUrl, playlist) {
    const lines = playlist.split(/\r?\n/);
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF")) {
        continue;
      }
      const nextUrl = findNextPlaylistUrl(lines, index + 1);
      if (!nextUrl) {
        continue;
      }
      variants.push({
        url: new URL(nextUrl, baseUrl).toString(),
        bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0),
        pixels: getResolutionPixels(line)
      });
    }
    if (!variants.length) {
      return baseUrl;
    }
    variants.sort((a, b) => (b.pixels - a.pixels) || (b.bandwidth - a.bandwidth));
    return variants[0].url;
  }
  function findNextPlaylistUrl(lines, startIndex) {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line && !line.startsWith("#")) {
        return line;
      }
    }
    return "";
  }
  function getResolutionPixels(line) {
    const match = line.match(/RESOLUTION=(\d+)x(\d+)/);
    return match ? Number(match[1]) * Number(match[2]) : 0;
  }
  /** Parse an HLS media playlist into absolute segment URLs. */
  function parseMediaPlaylist(baseUrl, playlist) {
    const lines = playlist.split(/\r?\n/);
    const parts = [];
    for (const line of lines) {
      const mapUri = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/)?.[1];
      if (mapUri) {
        parts.push(new URL(mapUri, baseUrl).toString());
        continue;
      }
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        parts.push(new URL(trimmed, baseUrl).toString());
      }
    }
    return parts;
  }
  function buildCaption(payload) {
    const author = escapeTelegramHtml(payload?.author || "");
    const text = String(payload?.text || "").trim();
    const tweetUrl = payload?.tweetUrl || "";
    const body = formatTweetTextForTelegram(text);
    const parts = [];
    if (author) {
      parts.push(author);
    }
    if (body) {
      parts.push(body);
    }
    if (tweetUrl) {
      parts.push(escapeTelegramHtml(tweetUrl));
    }
    return truncateTelegramCaption(parts.join("\n\n"));
  }
  function truncateTelegramCaption(caption) {
    if (caption.length <= 1024) {
      return caption;
    }
    const quoteStart = caption.search(/<blockquote(?:\s+expandable)?>/);
    const quoteEnd = caption.lastIndexOf("</blockquote>");
    if (quoteStart >= 0 && quoteEnd > quoteStart) {
      const openTagEnd = caption.indexOf(">", quoteStart) + 1;
      const prefix = caption.slice(0, openTagEnd);
      const quote = caption.slice(openTagEnd, quoteEnd);
      const suffix = caption.slice(quoteEnd);
      const maxQuoteLength = 1024 - prefix.length - suffix.length - 3;
      if (maxQuoteLength > 0) {
        return `${prefix}${truncateEscapedHtml(quote, maxQuoteLength)}...${suffix}`;
      }
    }
    return `${truncateEscapedHtml(caption, 1021)}...`;
  }
  function formatTweetTextForTelegram(text) {
    if (!text) {
      return "";
    }
    // Long tweets read better as Telegram blockquotes; a short first paragraph stays as the title.
    const paragraphs = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
    const isLongTweet = text.length > 280;
    const hasShortTitle = isLongTweet && paragraphs.length > 1 && paragraphs[0].length <= 80;
    if (!isLongTweet) {
      return escapeTelegramHtml(text);
    }
    if (hasShortTitle) {
      return [
        escapeTelegramHtml(paragraphs[0]),
        wrapTelegramQuote(paragraphs.slice(1).join("\n"))
      ].join("\n\n");
    }
    return wrapTelegramQuote(text);
  }
  function wrapTelegramQuote(text) {
    return `<blockquote expandable>${escapeTelegramHtml(text)}</blockquote>`;
  }
  function escapeTelegramHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
  function truncateEscapedHtml(value, maxLength) {
    const sliced = value.slice(0, maxLength).trimEnd();
    return sliced.replace(/&[^;\s]*$/, "");
  }
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
  function sleep(ms, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createCancelledError());
        return;
      }
      const timeoutId = setTimeout(resolve, ms);
      signal?.addEventListener?.("abort", () => {
        clearTimeout(timeoutId);
        reject(createCancelledError());
      }, { once: true });
    });
  }
  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw createCancelledError();
    }
  }
  function createCancelledError() {
    const error = new Error("Task cancelled by user.");
    error.code = "CANCELLED";
    return error;
  }
  /** Format bytes as a human-readable string for debug logs. */
  function formatDebugBytes(bytes) {
    if (!bytes) {
      return "--";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)}${units[unitIndex]}`;
  }
  /** Format milliseconds as a human-readable duration string. */
  function formatDuration(ms) {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    return `${Math.round(ms / 1000)}s`;
  }
})();
