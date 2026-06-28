/** Load Telegram configurations from the service worker via runtime messaging. */
async function loadTelegramConfigs() {
  const now = Date.now();
  if (configCache && now - configCacheAt < 2000) {
    return configCache;
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_TELEGRAM_CONFIGS" });
  if (!response?.ok) {

    // ==================== Button Mount Points ====================
    throw new Error(response?.error || chrome.i18n.getMessage("content_loadConfigFailed"));
  }

  configCache = Array.isArray(response.result) ? response.result : [];
  configCacheAt = now;
  return configCache;
}

function markConfigRecentlyUsed(configId) {
  const id = String(configId || "").trim();
  if (!id || !configCache) {
    return;
  }

  const now = Date.now();
  configCache = configCache.map((config) => (
    config.id === id ? { ...config, lastUsedAt: now } : config
  ));
  configCacheAt = now;
}

function setupDraftSync() {
  loadForwardDraft()
    .then((draft) => {
      draftCache = normalizeDraftCache(draft);
      syncAllButtonDraftState();
    })
    .catch(() => { });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, FORWARD_DRAFT_KEY)) {
      return;
    }

    draftCache = normalizeDraftCache(changes[FORWARD_DRAFT_KEY].newValue);
    syncAllButtonDraftState();
  });
}

async function loadForwardDraft() {
  const response = await chrome.runtime.sendMessage({ type: "GET_FORWARD_DRAFT" });
  return response?.ok ? response.result : null;
}

function normalizeDraftCache(draft) {
  if (!draft || typeof draft !== "object") {
    return null;
  }

  const items = Array.isArray(draft.items) ? draft.items.filter((item) => item?.sourceKey) : [];
  return items.length ? { ...draft, items } : null;
}

function getDraftMediaCount(draft) {
  return Number(draft?.count || draft?.items?.length || 0);
}

function isBatchForwardMode() {
  return getDraftMediaCount(draftCache) > 0;
}

function syncAllButtonDraftState() {
  if (isBatchForwardMode()) {
    hideConfigMenu();
  }

  document.querySelectorAll(`.${BUTTON_CLASS},#${BUTTON_ID}`).forEach(syncButtonDraftState);
}

function syncButtonDraftState(button) {
  if (!button) {
    return;
  }

  const count = getDraftMediaCount(draftCache);
  if (count > 0) {
    button.dataset.tfDraftCount = String(count);
  } else {
    delete button.dataset.tfDraftCount;
  }

  button.classList.toggle("tf-forward-in-draft", count > 0 && draftHasSourceKey(getDraftSourceKeyForButton(button)));
}

function draftHasSourceKey(sourceKey) {
  if (!sourceKey || !Array.isArray(draftCache?.items)) {
    return false;
  }

  return draftCache.items.some((item) => item?.sourceKey === sourceKey);
}

function getDraftSourceKeyForButton(button, payload = null) {
  const article = findPayloadTweetArticleForButton(button);
  const tweetUrl = payload?.tweetUrl || findTweetUrl(article) || normalizeTweetUrl(location.href);
  const tweetId = payload?.tweetId || getTweetIdFromUrl(tweetUrl);
  const route = getCurrentMediaRoute();

  if (route && (!tweetId || tweetId === route.tweetId || !article)) {
    return `${route.tweetId || tweetId}:${route.type}:${route.index}`;
  }

  return `tweet:${tweetId || tweetUrl}`;
}

function getCurrentMediaRoute() {
  const match = location.pathname.match(/\/status\/(\d+)\/(photo|video)\/(\d+)/);
  if (!match) {
    return null;
  }

  return {
    tweetId: match[1],
    type: match[2],
    index: Math.max(1, Number(match[3] || 1))
  };
}

function selectDraftPayloadMedia(payload, sourceKey) {
  const mediaItems = getPayloadMediaItems(payload);
  if (!mediaItems.length) {
    return payload;
  }

  const source = parseDraftMediaSourceKey(sourceKey);
  if (source?.type === "photo" || source?.type === "video") {
    // Media viewer URLs are one-based and usually match GraphQL media order.
    const mediaIndex = source.index - 1;
    let selected = mediaItems[mediaIndex] || null;
    if (!selected || !mediaMatchesRouteType(selected, source.type)) {
      selected = mediaItems.filter((item) => mediaMatchesRouteType(item, source.type))[mediaIndex] || selected;
    }

    if (selected) {
      return {
        ...payload,
        media: selected,
        mediaItems: [selected]
      };
    }
  }

  return {
    ...payload,
    media: mediaItems[0] || null,
    mediaItems
  };
}

function parseDraftMediaSourceKey(sourceKey) {
  const match = String(sourceKey || "").match(/^([^:]+):(photo|video):(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    tweetId: match[1],
    type: match[2],
    index: Math.max(1, Number(match[3] || 1))
  };
}

function mediaMatchesRouteType(media, routeType) {
  return routeType === "photo" ? media?.type === "photo" : media?.type === "video";
}

function getPayloadMediaItems(payload) {
  const mediaItems = Array.isArray(payload?.mediaItems) ? payload.mediaItems : [];
  const items = mediaItems.length ? mediaItems : (payload?.media ? [payload.media] : []);
  return items.filter((item) => item?.type === "photo" || item?.type === "video");
}

function assertForwardableMediaPayload(payload) {
  const mediaItems = getPayloadMediaItems(payload);
  if (!mediaItems.length) {
    throw new Error(MESSAGE_NO_MEDIA());
  }

  if (mediaItems.some((media) => media.type === "video" && !hasDownloadableVideoCandidate(media))) {
    throw new Error(MESSAGE_NO_DOWNLOADABLE_VIDEO());
  }
}

function hasDownloadableVideoCandidate(media) {
  return [
    media?.url,
    ...(Array.isArray(media?.candidates) ? media.candidates : [])
  ]
    .map((url) => typeof url === "string" ? cleanEscapedUrl(url) : "")
    .some((url) => url && !url.startsWith("blob:") && isDownloadableTwitterVideoResource(url));
}
