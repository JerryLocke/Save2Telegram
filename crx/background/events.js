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
