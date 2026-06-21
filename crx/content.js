(function () {
  const BUTTON_ID = "tf-forward-button";
  const WRAPPER_ID = "tf-forward-action";
  const BUTTON_CLASS = "tf-forward-button";
  const WRAPPER_CLASS = "tf-forward-action";
  const MENU_CLASS = "tf-forward-config-menu";
  const TOAST_ID = "tf-forward-toast";
  const FORWARD_DRAFT_KEY = "forwardDraft";
  const GRAPHQL_MEDIA_QUERY_TIMEOUT_MS = 3000;
  const GRAPHQL_MEDIA_CACHE_MESSAGE_SOURCE = "Save2Telegram";
  const GRAPHQL_MEDIA_CACHE_MESSAGE_TYPE = "GRAPHQL_MEDIA_CACHE";
  const MAX_GRAPHQL_MEDIA_CACHE_ENTRIES = 800;
  const LABEL_READY = function () { return chrome.i18n.getMessage("content_labelReady"); };
  const LABEL_SENDING = function () { return chrome.i18n.getMessage("content_labelSending"); };
  const LABEL_SENT = function () { return chrome.i18n.getMessage("content_labelSent"); };
  const LABEL_RECENT = function () { return chrome.i18n.getMessage("content_labelRecent"); };
  const MESSAGE_SENT = function () { return chrome.i18n.getMessage("content_messageSent"); };
  const MESSAGE_FAILED = function () { return chrome.i18n.getMessage("content_messageFailed"); };
  const MESSAGE_DRAFT_ADDED = function (count) { return chrome.i18n.getMessage("content_draftAdded", [count]); };
  const MESSAGE_DRAFT_REMOVED = function (count) { return chrome.i18n.getMessage("content_draftRemoved", [count]); };
  const MESSAGE_DRAFT_QUEUED = function () { return chrome.i18n.getMessage("content_draftQueued"); };
  const MESSAGE_NO_MEDIA = function () { return chrome.i18n.getMessage("content_noMedia"); };
  const MESSAGE_NO_DOWNLOADABLE_VIDEO = function () { return chrome.i18n.getMessage("content_noDownloadableVideo"); };
  const ICON_READY = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M21.7 3.3a1.1 1.1 0 0 0-1.2-.2L3 10.1a1.1 1.1 0 0 0 .1 2.1l4.8 1.5 1.8 5.7a1.1 1.1 0 0 0 2 .2l2.7-4.1 4.9 3.6a1.1 1.1 0 0 0 1.7-.7l1.1-14a1.1 1.1 0 0 0-.4-1.1Zm-4.2 4.4-8.2 7.1-.7-2.3 8.9-4.8Z"/>
  </svg>`;
  const ICON_SENT = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M9.5 16.7 4.8 12l-1.4 1.4 6.1 6.1L21 8l-1.4-1.4L9.5 16.7Z"/>
  </svg>`;

  let currentUrl = location.href;
  let renderTimer = null;
  let renderBurstTimers = [];
  let lastResourceRenderAt = 0;
  let configCache = null;
  let configCacheAt = 0;
  let draftCache = null;
  const graphqlMediaCache = new Map();

  init();


  // ==================== Initialization ====================
  /** Initialize content script: mount forward buttons on tweets and media viewer. */
  function init() {
    window.addEventListener("message", handleGraphqlMediaCacheMessage);
    installGraphqlResponseCapture();
    setupDraftSync();
    queueRenderBurst();
    patchHistoryNavigation();
    observeTweetResources();
    document.addEventListener("click", handlePotentialMediaClick, true);
    window.addEventListener("popstate", handleUrlMaybeChanged);
    window.addEventListener("pageshow", queueRenderBurst);
  }

  function installGraphqlResponseCapture() {
    const inject = () => {
      if (document.documentElement?.dataset.tfGraphqlCaptureInjected === "true") {
        return;
      }

      const parent = document.documentElement || document.head || document.body;
      if (!parent) {
        document.addEventListener("DOMContentLoaded", inject, { once: true });
        return;
      }

      const marker = document.documentElement || parent;
      marker.dataset.tfGraphqlCaptureInjected = "true";
      const script = document.createElement("script");
      script.async = false;
      script.src = chrome.runtime.getURL("page-graphql-capture.js");
      script.onload = () => script.remove();
      parent.append(script);
    };

    inject();
  }

  /** Monkey-patch history.pushState/replaceState to detect SPA navigation. */
  function patchHistoryNavigation() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      handleUrlMaybeChanged();
      return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      handleUrlMaybeChanged();
      return result;
    };
  }

  /** Check if the URL changed since last check; trigger re-render if so. */
  function checkUrlChange() {
    if (currentUrl === location.href) {
      return;
    }


    // ==================== Navigation Detection ====================
    currentUrl = location.href;
    queueRenderBurst();
  }

  /** Debounced handler for URL changes: queue a re-render. */
  function handleUrlMaybeChanged() {
    window.setTimeout(checkUrlChange, 0);
  }

  /** Detect clicks on media elements and capture video candidates. */
  function handlePotentialMediaClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest('a[href*="/status/"][href*="/photo/"],a[href*="/status/"][href*="/video/"]');
    if (link) {
      queueRenderBurst();
    }
  }

  /** Use PerformanceObserver to detect new tweet resources loading via XHR/fetch. */
  function observeTweetResources() {
    if (!("PerformanceObserver" in window)) {
      return;
    }

    const observer = new PerformanceObserver((list) => {
      if (list.getEntries().some((entry) => isTweetResource(entry.name))) {
        const now = Date.now();
        if (now - lastResourceRenderAt < 800) {
          return;
        }

        lastResourceRenderAt = now;
        queueRenderBurst();
      }
    });

    try {
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer.observe({ entryTypes: ["resource"] });
    }
  }

  /** Check if a URL is a tweet-related resource that warrants a re-render. */
  function isTweetResource(url) {
    return isTweetGraphqlUrl(url);
  }

  function queueRender() {
    if (renderTimer) {
      return;
    }

    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      renderButtons();
    }, 120);
  }

  function queueRenderBurst() {
    clearRenderBurst();
    [0, 160, 400, 900, 1800, 3200, 5200].forEach((delay) => {

      // ==================== Button Rendering ====================
      renderBurstTimers.push(window.setTimeout(queueRender, delay));
    });
  }

  function clearRenderBurst() {
    renderBurstTimers.forEach((timer) => window.clearTimeout(timer));
    renderBurstTimers = [];
  }

  /** Find all mount points and inject forward buttons where needed. */
  function renderButtons() {
    const existingWrappers = Array.from(document.querySelectorAll(`.${WRAPPER_CLASS},#${WRAPPER_ID}`));

    const mounts = findButtonMounts();
    if (!mounts.length) {
      existingWrappers.forEach((wrapper) => wrapper.remove());
      return false;
    }

    const mountedParents = new Set(mounts.map((mount) => mount.parent));

    existingWrappers.forEach((wrapper) => {
      if (!mountedParents.has(wrapper.parentElement)) {
        wrapper.remove();
      }
    });

    mounts.forEach(ensureButtonAtMount);
    return true;
  }

  /** Ensure a forward button exists at a given mount point. Returns the button. */
  function ensureButtonAtMount(mount) {
    const existingWrapper = Array.from(mount.parent.querySelectorAll(`.${WRAPPER_CLASS},#${WRAPPER_ID}`))
      .find((wrapper) => wrapper.dataset.tfForwardAction === "true");

    if (existingWrapper) {
      syncWrapperWithMount(existingWrapper, mount);
      const existingButton = existingWrapper.querySelector(`.${BUTTON_CLASS},#${BUTTON_ID}`);
      if (existingButton) {
        syncButtonSurface(existingButton, mount);
        bindButtonInteractions(existingWrapper, existingButton);
      }

      if (!isMountedAtTarget(existingWrapper, mount)) {
        insertAfter(mount.parent, existingWrapper, mount.after);
      }

      return;
    }

    const wrapper = document.createElement("div");
    syncWrapperWithMount(wrapper, mount);

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    setButtonState(button, false, LABEL_READY());
    syncButtonSurface(button, mount);
    bindButtonInteractions(wrapper, button);
    wrapper.append(button);
    insertAfter(mount.parent, wrapper, mount.after);
  }

  /** Wire click handlers and contextual menu to a forward button. */
  function bindButtonInteractions(wrapper, button) {
    if (wrapper.dataset.tfConfigMenuBound === "true") {
      return;
    }

    wrapper.dataset.tfConfigMenuBound = "true";
    button.addEventListener("click", (event) => handleForwardClick(event, wrapper, button));
    button.addEventListener("mouseenter", () => {
      if (isBatchForwardMode()) {
        hideConfigMenu(wrapper);
        return;
      }

      showConfigMenu(wrapper, button);
    });
    button.addEventListener("focus", () => {
      showConfigMenu(wrapper, button);
    });
    wrapper.addEventListener("mouseleave", () => scheduleHideConfigMenu(wrapper));
    wrapper.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!wrapper.contains(document.activeElement)) {
          hideConfigMenu(wrapper);
        }

        // ==================== Forward Action ====================
      }, 0);
    });
  }

  function needsMediaFooter() {
    return /\/status\/\d+\/(photo|video)\//.test(location.pathname);
  }

  /** Handle forward button click: load configs and send the tweet. */
  async function handleForwardClick(event, wrapper, button) {
    event?.preventDefault?.();

    try {
      const configs = await loadTelegramConfigs();
      if (!configs.length) {
        showToast(chrome.i18n.getMessage("content_noConfig"), true);
        return;
      }

      await handleForwardAction(event, button, getDefaultForwardConfig(configs).id);
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  }

  async function handleForwardAction(event, button, configId = "", options = {}) {
    const hasDraft = getDraftMediaCount(draftCache) > 0;
    if (event?.ctrlKey) {
      if (hasDraft) {
        await sendDraftForward(button, configId, options);
      } else {
        await toggleDraftMedia(button, configId, options);
      }
      return;
    }

    if (hasDraft) {
      await toggleDraftMedia(button, configId, options);
      return;
    }

    await sendForward(button, configId);
  }

  /** Send the tweet payload to the extension service worker for forwarding. */
  async function sendForward(button, configId = "") {
    setButtonState(button, true, LABEL_SENDING());

    try {
      let payload = collectTweetPayload(button);
      payload = await hydrateTweetPayloadMediaFromGraphql(payload);
      assertForwardableMediaPayload(payload);
      const response = await chrome.runtime.sendMessage({
        type: "FORWARD_TWITTER_MEDIA",
        payload,
        configId
      });

      if (!response?.ok) {
        throw new Error(response?.error || MESSAGE_FAILED());
      }

      markConfigRecentlyUsed(configId);
      showToast(MESSAGE_SENT());
      setButtonState(button, false, LABEL_SENT());
      setTimeout(() => setButtonState(button, false, LABEL_READY()), 1200);
    } catch (error) {
      showToast(error.message || String(error), true);
      setButtonState(button, false, LABEL_READY());
    }
  }

  async function toggleDraftMedia(button, configId = "", options = {}) {
    setButtonState(button, true, LABEL_SENDING());

    try {
      const { payload, sourceKey } = await collectDraftPayload(button);
      const response = await chrome.runtime.sendMessage({
        type: "TOGGLE_FORWARD_DRAFT_MEDIA",
        payload,
        configId,
        sourceKey,
        preferConfig: Boolean(options.preferConfig)
      });

      if (!response?.ok) {
        throw new Error(response?.error || MESSAGE_FAILED());
      }

      draftCache = response.result?.draft || null;
      syncAllButtonDraftState();
      const count = getDraftMediaCount(draftCache);
      showToast(response.result?.action === "removed" ? MESSAGE_DRAFT_REMOVED(count) : MESSAGE_DRAFT_ADDED(count));
      setButtonState(button, false, LABEL_READY());
    } catch (error) {
      showToast(error.message || String(error), true);
      setButtonState(button, false, LABEL_READY());
    }
  }

  async function sendDraftForward(button, configId = "", options = {}) {
    setButtonState(button, true, LABEL_SENDING());

    try {
      const { payload, sourceKey } = await collectDraftPayload(button);
      const response = await chrome.runtime.sendMessage({
        type: "SEND_FORWARD_DRAFT",
        payload,
        configId,
        sourceKey,
        preferConfig: Boolean(options.preferConfig)
      });

      if (!response?.ok) {
        throw new Error(response?.error || MESSAGE_FAILED());
      }

      markConfigRecentlyUsed(configId);
      draftCache = response.result?.draft || null;
      syncAllButtonDraftState();
      showToast(MESSAGE_DRAFT_QUEUED());
      setButtonState(button, false, LABEL_SENT());
      setTimeout(() => setButtonState(button, false, LABEL_READY()), 1200);
    } catch (error) {
      showToast(error.message || String(error), true);
      setButtonState(button, false, LABEL_READY());
    }
  }

  async function collectDraftPayload(button) {
    let payload = collectTweetPayload(button);
    payload = await hydrateTweetPayloadMediaFromGraphql(payload);
    const sourceKey = getDraftSourceKeyForButton(button, payload);
    const draftPayload = selectDraftPayloadMedia(payload, sourceKey);
    assertForwardableMediaPayload(draftPayload);
    return {
      payload: draftPayload,
      sourceKey
    };
  }

  /** Show a dropdown menu of Telegram configurations for the user to pick. */
  async function showConfigMenu(wrapper, button, options = {}) {
    if (!wrapper || !button) {
      return;
    }

    const configs = await loadTelegramConfigs();
    if (configs.length <= 1 && !options.force) {
      hideConfigMenu(wrapper);
      return;
    }

    const menu = ensureConfigMenu(wrapper);
    menu.replaceChildren();

    if (!configs.length) {
      const empty = document.createElement("div");
      empty.className = "tf-forward-config-empty";
      empty.textContent = chrome.i18n.getMessage("content_noConfig");
      menu.append(empty);
    } else {
      const recentConfig = getRecentlyUsedConfig(configs);
      configs
        .slice()
        .forEach((config) => menu.append(createConfigMenuItem(config, button, wrapper, config.id === recentConfig?.id)));
    }

    const rect = button.getBoundingClientRect();
    menu.style.right = `${Math.round(window.innerWidth - rect.right - 20)}px`;
    menu.style.bottom = `${Math.round(window.innerHeight - rect.top + 2)}px`;

    menu.hidden = false;
  }

  /** Get or create the shared config menu element. */
  function ensureConfigMenu(wrapper) {
    let menu = wrapper.querySelector(`.${MENU_CLASS}`);
    if (!menu) {
      menu = document.querySelector(`.${MENU_CLASS}`);
    }
    if (menu) {
      return menu;
    }

    menu = document.createElement("div");
    menu.className = MENU_CLASS;
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    return menu;
  }

  /** Create a config menu item button. */
  function createConfigMenuItem(config, button, wrapper, isRecent = false) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tf-forward-config-item";
    item.setAttribute("role", "menuitem");

    const label = document.createElement("span");
    label.className = "tf-forward-config-label";
    label.textContent = config.note || config.chatId || chrome.i18n.getMessage("content_unnamedConfig");
    item.append(label);

    if (isRecent) {
      const badge = document.createElement("span");
      badge.className = "tf-forward-config-badge";
      badge.textContent = LABEL_RECENT();
      item.append(badge);
    }

    item.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideConfigMenu(wrapper);
      await handleForwardAction(event, button, config.id, { preferConfig: true });
    });

    return item;
  }

  function getRecentlyUsedConfig(configs) {
    return configs.reduce((latest, config) => {
      const usedAt = Number(config?.lastUsedAt || 0);
      if (!usedAt) {
        return latest;
      }

      return !latest || usedAt > Number(latest.lastUsedAt || 0) ? config : latest;
    }, null);
  }

  function getDefaultForwardConfig(configs) {
    return getRecentlyUsedConfig(configs) || configs[0];
  }

  /** Hide the config menu. */
  function hideConfigMenu(wrapper) {
    const menu = document.querySelector(`.${MENU_CLASS}`);
    if (menu) {
      menu.hidden = true;
    }
  }

  function scheduleHideConfigMenu(wrapper) {
    const menu = document.querySelector(`.${MENU_CLASS}`);
    if (!menu || menu.hidden) {
      return;
    }

    clearHideTimer(wrapper);
    wrapper.dataset.tfHideTimer = String(window.setTimeout(() => hideConfigMenu(wrapper), 180));

    bindMenuHover(menu, wrapper);
  }

  function bindMenuHover(menu, wrapper) {
    if (menu.dataset.tfHoverBound === "true") {
      return;
    }

    menu.dataset.tfHoverBound = "true";
    menu.addEventListener("mouseenter", () => clearHideTimer(wrapper));
    menu.addEventListener("mouseleave", () => scheduleHideConfigMenu(wrapper));
  }

  function clearHideTimer(wrapper) {
    const id = Number(wrapper.dataset.tfHideTimer);
    if (id) {
      window.clearTimeout(id);
      wrapper.dataset.tfHideTimer = "";
    }
  }

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

  /** Find all locations where forward buttons should be injected. */
  function findButtonMounts() {
    const mounts = [];
    const seenParents = new Set();

    for (const mount of findMediaViewerButtonMounts()) {
      if (!seenParents.has(mount.parent)) {
        seenParents.add(mount.parent);
        mounts.push(mount);
      }
    }

    for (const mount of findTweetArticleButtonMounts()) {
      if (mount && !seenParents.has(mount.parent)) {
        seenParents.add(mount.parent);
        mounts.push(mount);
      }
    }

    return mounts;
  }

  /** Find mount points inside tweet action rows on the timeline. */
  function findTweetArticleButtonMounts() {
    const mounts = [];
    const articles = findTweetArticles();

    for (const article of articles) {
      const actionRow = findFooterActionRow(article);
      const mount = actionRow ? createMountFromActionRow(actionRow, "default") : null;
      if (mount) {
        mounts.push(mount);
      }
    }

    return mounts;
  }

  /** Find mount points on the media viewer / photo detail page. */
  function findMediaViewerButtonMounts() {
    if (!needsMediaFooter()) {
      return [];
    }

    const mounts = [];
    const roots = [
      ...Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(isVisible),
      document.body
    ].filter(Boolean);

    for (const root of roots) {
      const groups = findFooterActionRows(root, { allowCompactMediaFooter: true });
      for (const group of groups) {
        const surface = isDarkSurface(group) ? "media" : "default";
        const mount = createMountFromActionRow(group, surface);
        if (mount && !mounts.some((candidate) => candidate.parent === mount.parent)) {
          mounts.push(mount);
        }
      }
    }

    return mounts;
  }

  /** Create a mount descriptor from an action row element. */
  function createMountFromActionRow(actionRow, surface) {
    const shareAction = findShareAction(actionRow);
    const directActionChild = shareAction ? findDirectChild(actionRow, shareAction) : null;

    if (!directActionChild) {
      return null;
    }

    return {
      parent: actionRow,
      after: directActionChild,
      itemClassName: directActionChild.className || "",
      surface
    };
  }

  function findFooterActionRows(root, options = {}) {
    const shareActions = findShareCandidates(root)
      .filter((element) => element.id !== BUTTON_ID && !element.classList.contains(BUTTON_CLASS) && isVisible(element))
      .filter(isShareAction);

    const rows = [];
    for (const shareAction of shareActions) {
      const group = shareAction.closest('[role="group"]');
      if (!group || rows.includes(group)) {
        continue;
      }

      const rect = group.getBoundingClientRect();
      const looksLikeFooter = rect.height <= 80 && rect.width >= 80;
      const hasStandardActions = Boolean(group.querySelector('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]'));
      const hasMediaStats = /\d/.test(group.innerText || "") && rect.width >= 120;

      if (looksLikeFooter && (hasStandardActions || (options.allowCompactMediaFooter && hasMediaStats))) {
        rows.push(group);
      }
    }

    return rows;
  }

  function insertAfter(parent, node, anchor) {
    if (!anchor) {
      parent.append(node);
      return;
    }


    // ==================== Theme Detection ====================
    anchor.after(node);
  }

  function ensureButtonWrapper(button) {
    const currentWrapper = button.closest(`.${WRAPPER_CLASS},#${WRAPPER_ID}`);
    if (currentWrapper) {
      return currentWrapper;
    }

    const wrapper = document.createElement("div");
    button.replaceWith(wrapper);
    wrapper.append(button);
    return wrapper;
  }

  function syncWrapperWithMount(wrapper, mount) {
    wrapper.removeAttribute("id");
    wrapper.className = [mount.itemClassName, WRAPPER_CLASS].filter(Boolean).join(" ");
    wrapper.dataset.tfForwardAction = "true";
    wrapper.style.marginLeft = "12px";
  }

  function syncButtonSurface(button, mount) {
    button.dataset.tfSurface = mount.surface || "default";
    syncButtonDraftState(button);
  }

  function isDarkSurface(element) {
    let node = element;

    while (node && node !== document.documentElement) {
      const luminance = getBackgroundLuminance(getComputedStyle(node).backgroundColor);
      if (luminance !== null) {
        return luminance < 80;
      }

      node = node.parentElement;
    }

    return false;
  }

  function getBackgroundLuminance(color) {
    const parts = color.match(/\d+(\.\d+)?/g);
    if (!parts || parts.length < 3) {
      return null;
    }

    const [red, green, blue, alpha = 1] = parts.map(Number);
    if (alpha === 0) {
      return null;
    }

    return (red * 299 + green * 587 + blue * 114) / 1000;
  }

  function isMountedAtTarget(node, mount) {
    if (node.parentElement !== mount.parent) {
      return false;
    }

    if (!mount.after) {
      return !node.nextElementSibling;
    }

    return node.previousElementSibling === mount.after;
  }

  function findFooterActionRow(article) {
    return findFooterActionRows(article)[0] || null;
  }

  function findShareAction(root) {
    const actions = findShareCandidates(root)
      .filter((element) => element.id !== BUTTON_ID && !element.classList.contains(BUTTON_CLASS) && isVisible(element));

    return actions.find(isShareAction) || null;
  }

  function findShareCandidates(root) {
    const selectors = [
      '[data-testid="share"]',
      'button[aria-label*="Share"]',
      '[role="button"][aria-label*="Share"]',
      'button[aria-label*="\u5206\u4eab"]',
      '[role="button"][aria-label*="\u5206\u4eab"]'
    ];

    const candidates = [];
    for (const selector of selectors) {
      root.querySelectorAll(selector).forEach((element) => {

        // ==================== Payload Extraction ====================
        if (!candidates.includes(element)) {
          candidates.push(element);
        }
      });
    }

    return candidates;
  }

  function isShareAction(element) {
    const testId = element.getAttribute("data-testid") || "";
    const label = `${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`.toLowerCase();
    return testId === "share" ||
      label.includes("share") ||
      label.includes("\u5206\u4eab");
  }

  function findDirectChild(parent, descendant) {
    let node = descendant;

    while (node?.parentElement && node.parentElement !== parent) {
      node = node.parentElement;
    }

    return node?.parentElement === parent ? node : descendant;
  }

  /** Collect tweet metadata (author, text, URL, media) from the DOM for forwarding. */
  function collectTweetPayload(sourceButton) {
    // Multiple tweet articles can share one status page; the clicked footer decides which tweet to forward.
    const article = findPayloadTweetArticleForButton(sourceButton);
    const tweetUrl = findTweetUrl(article) || normalizeTweetUrl(location.href);

    return {
      tweetUrl,
      tweetId: getTweetIdFromUrl(tweetUrl),
      author: extractAuthor(article),
      text: extractTweetText(article),
      media: null,
      mediaItems: []
    };
  }

  function handleGraphqlMediaCacheMessage(event) {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (data?.source !== GRAPHQL_MEDIA_CACHE_MESSAGE_SOURCE ||
      data?.type !== GRAPHQL_MEDIA_CACHE_MESSAGE_TYPE ||
      !Array.isArray(data.tweets)) {
      return;
    }

    for (const tweet of data.tweets) {
      rememberGraphqlMediaItems(tweet?.tweetId, tweet?.mediaItems);
    }
  }

  function rememberGraphqlMediaItems(tweetId, mediaItems) {
    const id = String(tweetId || "").trim();
    const normalizedItems = normalizeCachedMediaItems(mediaItems);
    if (!id || !normalizedItems.length) {
      return;
    }

    graphqlMediaCache.delete(id);
    graphqlMediaCache.set(id, {
      mediaItems: normalizedItems,
      updatedAt: Date.now()
    });
    trimGraphqlMediaCache();
  }

  function getCachedGraphqlMediaItems(tweetId) {
    const cached = graphqlMediaCache.get(String(tweetId || "").trim());
    return cached?.mediaItems ? cloneMediaItems(cached.mediaItems) : [];
  }

  function normalizeCachedMediaItems(mediaItems) {
    if (!Array.isArray(mediaItems)) {
      return [];
    }

    return dedupeMediaItems(mediaItems
      .map(normalizeCachedMediaItem)
      .filter(Boolean));
  }

  function normalizeCachedMediaItem(media) {
    if (media?.type === "photo") {
      const url = typeof media.url === "string" ? media.url : "";
      if (!url) {
        return null;
      }

      return {
        type: "photo",
        url: stripImageSizeParams(url),
        thumbnail: stripImageSizeParams(media.thumbnail || url)
      };
    }

    if (media?.type === "video") {
      const candidates = [
        ...(Array.isArray(media.candidates) ? media.candidates : []),
        media.url
      ]
        .map((url) => typeof url === "string" ? cleanEscapedUrl(url) : "")
        .filter((url) => url && isDownloadableTwitterVideoResource(url));
      const uniqueCandidates = [...new Set(candidates)];
      const thumbnail = typeof media.thumbnail === "string" ? media.thumbnail : "";

      return {
        type: "video",
        url: uniqueCandidates[0] || "",
        thumbnail: thumbnail ? stripImageSizeParams(thumbnail) : "",
        sourceId: typeof media.sourceId === "string" ? media.sourceId : "",
        candidates: uniqueCandidates
      };
    }

    return null;
  }

  function cloneMediaItems(mediaItems) {
    return mediaItems.map((media) => ({
      ...media,
      candidates: Array.isArray(media.candidates) ? [...media.candidates] : media.candidates
    }));
  }

  function trimGraphqlMediaCache() {
    while (graphqlMediaCache.size > MAX_GRAPHQL_MEDIA_CACHE_ENTRIES) {
      const oldestKey = graphqlMediaCache.keys().next().value;
      graphqlMediaCache.delete(oldestKey);
    }
  }

  async function hydrateTweetPayloadMediaFromGraphql(payload) {
    const tweetId = payload?.tweetId || getTweetIdFromUrl(payload?.tweetUrl);
    if (!tweetId) {
      return payload;
    }

    try {
      const cachedMediaItems = getCachedGraphqlMediaItems(tweetId);
      const mediaItems = cachedMediaItems.length ? cachedMediaItems : await fetchGraphqlTweetMediaItems(tweetId);
      if (!mediaItems.length) {
        return payload;
      }

      rememberGraphqlMediaItems(tweetId, mediaItems);
      return {
        ...payload,
        tweetId,
        media: mediaItems[0] || null,
        mediaItems
      };
    } catch {
      return payload;
    }
  }

  async function fetchGraphqlTweetMediaItems(tweetId) {
    const capturedRequests = await getCapturedTweetGraphqlRequests();
    const directRequest = buildTweetGraphqlRequest(tweetId, capturedRequests);
    if (!directRequest) {
      return [];
    }

    return fetchGraphqlRequestMediaItems(directRequest, tweetId);
  }

  async function fetchGraphqlRequestMediaItems(request, tweetId) {
    if (!request?.url || !request.headers) {
      return [];
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), GRAPHQL_MEDIA_QUERY_TIMEOUT_MS);

    try {
      const response = await fetch(request.url, {
        credentials: "include",
        signal: controller.signal,
        headers: request.headers
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const tweet = findGraphqlTweetById(data, tweetId);
      return extractGraphqlMediaItems(tweet);
    } catch {
      return [];
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function buildTweetGraphqlRequest(tweetId, capturedRequests) {
    const templates = findTweetGraphqlRequestTemplates(capturedRequests);
    const preferredTemplate = templates.find((template) => template.operationName === "TweetResultByRestId") ||
      templates.find((template) => template.operationName === "TweetDetail");
    if (!preferredTemplate) {
      return null;
    }

    const url = new URL(preferredTemplate.url, location.href);
    url.protocol = location.protocol;
    url.host = location.host;

    const variables = parseJsonSearchParam(url.searchParams.get("variables")) || {};
    if (preferredTemplate.operationName === "TweetResultByRestId") {
      variables.tweetId = tweetId;
    } else {
      variables.focalTweetId = tweetId;
    }

    url.searchParams.set("variables", JSON.stringify(variables));
    return {
      url: url.toString(),
      headers: preferredTemplate.headers
    };
  }

  function findTweetGraphqlRequestTemplates(requests) {
    const templates = (Array.isArray(requests) ? requests : [])
      .map(parseTweetGraphqlRequestTemplate)
      .filter(Boolean);
    const seen = new Set();
    return templates
      .reverse()
      .filter((template) => {
        const key = template.operationName;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });
  }

  async function getCapturedTweetGraphqlRequests() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_TWEET_GRAPHQL_REQUESTS" });
      return Array.isArray(response?.result) ? response.result.filter((request) => isTweetGraphqlUrl(request?.url)) : [];
    } catch {
      return [];
    }
  }

  function parseTweetGraphqlRequestTemplate(request) {
    const template = parseTweetGraphqlTemplate(request?.url);
    const headers = normalizeGraphqlHeaders(request?.headers);
    if (!template || !headers) {
      return null;
    }

    return {
      ...template,
      headers
    };
  }

  function normalizeGraphqlHeaders(headers) {
    if (!headers || typeof headers !== "object") {
      return null;
    }

    const allowedHeaders = [
      "authorization",
      "content-type",
      "x-csrf-token",
      "x-twitter-active-user",
      "x-twitter-auth-type",
      "x-twitter-client-language"
    ];
    const result = {};
    for (const name of allowedHeaders) {
      const value = getHeaderCaseInsensitive(headers, name);
      if (value) {
        result[name] = value;
      }
    }

    return result.authorization && result["x-csrf-token"] ? result : null;
  }

  function getHeaderCaseInsensitive(headers, name) {
    const match = Object.entries(headers)
      .find(([key]) => key.toLowerCase() === name.toLowerCase());
    return typeof match?.[1] === "string" ? match[1] : "";
  }

  function parseTweetGraphqlTemplate(url) {
    try {
      const parsed = new URL(url, location.href);
      const operationName = getGraphqlOperationName(parsed.toString());
      if (!isDirectTweetGraphqlOperation(operationName)) {
        return null;
      }

      return { url: parsed.toString(), operationName };
    } catch {
      return null;
    }
  }

  function isTweetGraphqlUrl(url) {
    if (typeof url !== "string" || !url.includes("/i/api/graphql/")) {
      return false;
    }

    return isTweetGraphqlOperation(getGraphqlOperationName(url));
  }

  function getGraphqlOperationName(url) {
    try {
      return new URL(url, location.href).pathname.match(/\/i\/api\/graphql\/[^/]+\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  }

  function isTweetGraphqlOperation(operationName) {
    if (isDirectTweetGraphqlOperation(operationName)) {
      return true;
    }

    return /(?:Timeline|Tweets|Bookmarks|SearchTimeline|UserMedia|Likes)/.test(operationName) &&
      !/^(Create|Delete|Favorite|Retweet|Unretweet|BookmarkTweet|Unbookmark|LikeTweet|UnlikeTweet|Follow|Mute|Block|Report|Update|Edit)/.test(operationName);
  }

  function isDirectTweetGraphqlOperation(operationName) {
    return operationName === "TweetResultByRestId" || operationName === "TweetDetail";
  }

  function parseJsonSearchParam(value) {
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function findGraphqlTweetById(value, tweetId, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return null;
    }

    seen.add(value);

    const unwrapped = unwrapGraphqlTweet(value);
    if (unwrapped?.rest_id === tweetId && unwrapped?.legacy) {
      return unwrapped;
    }

    for (const child of Object.values(value)) {
      const found = findGraphqlTweetById(child, tweetId, seen);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function unwrapGraphqlTweet(value) {
    let current = value;
    const seen = new Set();

    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);

      if (current.rest_id && current.legacy) {
        return current;
      }

      if (current.tweet && typeof current.tweet === "object") {
        current = current.tweet;
        continue;
      }

      if (current.tweet_results?.result && typeof current.tweet_results.result === "object") {
        current = current.tweet_results.result;
        continue;
      }

      break;
    }

    return current;
  }

  function extractGraphqlMediaItems(tweet) {
    const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];
    if (!Array.isArray(media) || !media.length) {
      return [];
    }

    return dedupeMediaItems(media
      .map(createMediaItemFromGraphqlMedia)
      .filter(Boolean));
  }

  function createMediaItemFromGraphqlMedia(media) {
    if (media?.type === "photo") {
      const url = media.media_url_https || media.media_url || "";
      if (!url) {
        return null;
      }

      return {
        type: "photo",
        url: stripImageSizeParams(url),
        thumbnail: stripImageSizeParams(url)
      };
    }

    if (media?.type === "video" || media?.type === "animated_gif") {
      const candidates = getGraphqlVideoCandidates(media);
      const thumbnail = media.media_url_https || media.media_url || "";
      return {
        type: "video",
        url: candidates[0] || "",
        thumbnail: thumbnail ? stripImageSizeParams(thumbnail) : "",
        sourceId: getGraphqlMediaSourceId(media),
        candidates
      };
    }

    return null;
  }

  function getGraphqlVideoCandidates(media) {
    const variants = Array.isArray(media?.video_info?.variants) ? media.video_info.variants : [];
    const candidates = variants
      .map((variant) => ({
        url: typeof variant?.url === "string" ? cleanEscapedUrl(variant.url) : "",
        bitrate: Number(variant?.bitrate || 0),
        contentType: String(variant?.content_type || "")
      }))
      .filter((variant) => variant.url && isDownloadableTwitterVideoResource(variant.url))
      .sort(rankGraphqlVideoVariant);

    const seen = new Set();
    return candidates
      .map((variant) => variant.url)
      .filter((url) => {
        if (seen.has(url)) {
          return false;
        }

        seen.add(url);
        return true;
      });
  }

  function rankGraphqlVideoVariant(a, b) {
    const aIsMp4 = isMp4VideoVariant(a);
    const bIsMp4 = isMp4VideoVariant(b);
    if (aIsMp4 !== bIsMp4) {
      return bIsMp4 - aIsMp4;
    }

    const bitrateDiff = Number(b.bitrate || 0) - Number(a.bitrate || 0);
    if (bitrateDiff) {
      return bitrateDiff;
    }

    return getVideoCandidatePixels(b.url) - getVideoCandidatePixels(a.url);
  }

  function isMp4VideoVariant(variant) {
    return variant?.url?.includes(".mp4") || variant?.contentType === "video/mp4";
  }

  function getGraphqlMediaSourceId(media) {
    const mediaKeyId = String(media?.media_key || "").split("_").pop();
    return getTwitterVideoMediaId(media?.media_url_https || media?.media_url || "") ||
      getTwitterVideoMediaId(media?.expanded_url || "") ||
      getTwitterVideoMediaId(mediaKeyId) ||
      getTwitterVideoMediaId(media?.id_str || "") ||
      "";
  }

  function getTweetIdFromUrl(url) {
    try {
      return new URL(url, location.href).pathname.match(/\/status\/(\d+)/)?.[1] || "";
    } catch {
      return "";
    }
  }

  function findTweetArticleForButton(button) {
    return button?.closest?.("article") || null;
  }

  function findPayloadTweetArticleForButton(button) {
    const buttonArticle = findTweetArticleForButton(button);
    return buttonArticle || findMainTweetArticle();
  }

  /** Extract the canonical tweet URL from a tweet article element. */
  function findTweetUrl(article) {
    const link = Array.from(article?.querySelectorAll('a[href*="/status/"]') || [])
      .map((anchor) => anchor.href)
      .find(isTweetStatusUrl);

    return link ? normalizeTweetUrl(link) : "";
  }

  function isTweetStatusUrl(href) {
    try {
      return /\/[^/]+\/status\/\d+/.test(new URL(href, location.href).pathname);
    } catch {
      return false;

      // ==================== Media Discovery ====================
    }
  }

  function findMainTweetArticle() {
    const articles = findTweetArticles();
    return articles.find((article) => article.querySelector('[data-testid="tweetText"]')) || articles[0] || null;
  }

  function findTweetArticles() {
    // Status, timeline, search, and profile pages can all contain multiple tweet articles.
    return Array.from(document.querySelectorAll("article"))
      .filter(isVisible)
      .filter((article) => findTweetUrl(article))
      .filter((article) => article.querySelector('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]'));
  }

  function extractAuthor(article) {
    const userName = article?.querySelector('[data-testid="User-Name"]')?.innerText?.trim();
    if (userName) {
      return userName.split("\n").filter(Boolean).slice(0, 2).join(" ");
    }

    return "";
  }

  function extractTweetText(article) {
    const el = article?.querySelector('[data-testid="tweetText"]');
    if (!el) return "";
    return el.textContent.trim();
  }

  /** Deduplicate media items by URL, keeping the first occurrence. */
  function dedupeMediaItems(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.type}:${item.url || item.candidates?.[0] || ""}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function getTwitterVideoMediaId(url) {
    const value = typeof url === "string" ? cleanEscapedUrl(url) : "";
    if (!value) {
      return "";
    }
    if (/^[A-Za-z0-9_-]{4,}$/.test(value)) {
      return value;
    }

    const pathMatch = value.match(/\/(?:amplify_video|amplify_video_thumb|ext_tw_video|ext_tw_video_thumb)\/([^/?#]+)\//);
    if (pathMatch) {
      return pathMatch[1];
    }

    const tweetVideoMatch = value.match(/\/(?:tweet_video|tweet_video_thumb)\/([^/?#.]+)/);
    return tweetVideoMatch?.[1] || "";
  }

  function isTwitterVideoResource(url) {
    return url.includes("video.twimg.com") && (
      url.includes(".mp4") ||
      url.includes(".m3u8")
    );
  }

  function isDownloadableTwitterVideoResource(url) {
    return isTwitterVideoResource(url) && !/\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url);
  }

  function cleanEscapedUrl(url) {
    return url
      .replaceAll("\\/", "/")
      .replaceAll("&amp;", "&")
      .replace(/\\u0026/g, "&");
  }

  function getVideoCandidatePixels(url) {
    const match = url.match(/\/(\d+)x(\d+)\//);
    return match ? Number(match[1]) * Number(match[2]) : 0;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 8 && rect.height > 8 && style.visibility !== "hidden" && style.display !== "none";
  }

  // ==================== UI Helpers ====================

  function stripImageSizeParams(url) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("name", "orig");
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /** Normalize a tweet URL to its canonical form, stripping query params. */
  function normalizeTweetUrl(url) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/([^/]+)\/status\/(\d+)/);
      if (!match) {
        return url;
      }

      return `https://x.com/${match[1]}/status/${match[2]}`;
    } catch {
      return url;
    }
  }

  /** Update a forward button's disabled state and label. */
  function setButtonState(button, disabled, label) {
    if (!button) {
      return;
    }

    button.disabled = disabled;
    button.innerHTML = label === LABEL_SENT() ? ICON_SENT : ICON_READY;
    // X's native tooltip is internal to its React tree; browser-native title avoids brittle imitation.
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  /** Display a toast notification on the page. */
  function showToast(message, isError = false) {
    document.getElementById(TOAST_ID)?.remove();

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = isError ? "tf-error" : "";
    toast.textContent = message;
    document.body.append(toast);

    setTimeout(() => toast.remove(), 3200);
  }

})();
