(function () {
  const BUTTON_ID = "tf-forward-button";
  const WRAPPER_ID = "tf-forward-action";
  const BUTTON_CLASS = "tf-forward-button";
  const WRAPPER_CLASS = "tf-forward-action";
  const MENU_CLASS = "tf-forward-config-menu";
  const TOAST_ID = "tf-forward-toast";
  const LABEL_READY = function () { return chrome.i18n.getMessage("content_labelReady"); };
  const LABEL_SENDING = function () { return chrome.i18n.getMessage("content_labelSending"); };
  const LABEL_SENT = function () { return chrome.i18n.getMessage("content_labelSent"); };
  const LABEL_RECENT = function () { return chrome.i18n.getMessage("content_labelRecent"); };
  const MESSAGE_SENT = function () { return chrome.i18n.getMessage("content_messageSent"); };
  const MESSAGE_FAILED = function () { return chrome.i18n.getMessage("content_messageFailed"); };
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

  init();


  // ==================== Initialization ====================
  /** Initialize content script: mount forward buttons on tweets and media viewer. */
  function init() {
    queueRenderBurst();
    patchHistoryNavigation();
    observeTweetResources();
    document.addEventListener("click", handlePotentialMediaClick, true);
    window.addEventListener("popstate", handleUrlMaybeChanged);
    window.addEventListener("pageshow", queueRenderBurst);
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
    return url.includes("/graphql/") &&
      (url.includes("TweetDetail") ||
        url.includes("TweetResultByRestId") ||
        url.includes("UserTweets") ||
        url.includes("HomeTimeline") ||
        url.includes("Bookmarks"));
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

    if (!isTwitterMediaPage()) {
      existingWrappers.forEach((wrapper) => wrapper.remove());
      return true;
    }

    const mounts = findButtonMounts();
    if (!mounts.length) {
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
    button.addEventListener("mouseenter", () => showConfigMenu(wrapper, button));
    button.addEventListener("focus", () => showConfigMenu(wrapper, button));
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

  function isTwitterMediaPage() {
    const path = location.pathname;
    return /\/status\/\d+/.test(path);
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

      await sendForward(button, getDefaultForwardConfig(configs).id);
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  }

  /** Send the tweet payload to the extension service worker for forwarding. */
  async function sendForward(button, configId = "") {
    setButtonState(button, true, LABEL_SENDING());

    try {
      const payload = collectTweetPayload(button);
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
      await sendForward(button, config.id);
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
    ];

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
    const article = findTweetArticleForButton(sourceButton) || findMainTweetArticle();
    // Keep the legacy single media field while adding mediaItems for mixed photo/video tweets.
    const mediaItems = findVisibleMediaItems(article || document);
    const media = mediaItems[0] || null;

    return {
      tweetUrl: findTweetUrl(article) || normalizeTweetUrl(location.href),
      author: extractAuthor(article),
      text: extractTweetText(article),
      media,
      mediaItems
    };
  }

  function findTweetArticleForButton(button) {
    return button?.closest?.("article") || null;
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
    // Status pages can contain the source tweet plus one or more reply articles.
    return Array.from(document.querySelectorAll("article"))
      .filter(isVisible)
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

  /** Find visible media items (images/videos) on the current page or in a tweet. */
  function findVisibleMedia(root = document) {
    return findVisibleMediaItems(root)[0] || null;
  }

  /** Find visible <img> and <video> elements and extract their metadata. */
  function findVisibleMediaItems(root = document) {
    // Mixed tweets render photos and videos as separate DOM media nodes inside the same article.
    const items = [];
    const videos = findVisibleElements("video", root);

    for (const video of videos) {
      const videoCandidates = collectVideoCandidates(video);
      items.push({
        type: "video",
        url: video.currentSrc || video.src || videoCandidates[0] || "",
        thumbnail: findVideoThumbnail(video),
        candidates: videoCandidates,
        order: getElementOrder(video)
      });
    }

    const images = Array.from(root.querySelectorAll('img[src*="twimg.com/media"]'))
      .filter(isVisible)
      .map((image) => ({
        type: "photo",
        url: stripImageSizeParams(image.src),
        thumbnail: stripImageSizeParams(image.src),
        order: getElementOrder(image)
      }));

    for (const image of dedupeMediaItems(images)) {
      items.push(image);
    }

    const sortedItems = dedupeMediaItems(items)
      .sort((a, b) => a.order - b.order)
      .map(({ order, ...item }) => item);

    const videoCandidates = videos.length ? [] : collectVideoCandidates(null);
    if (!sortedItems.length && (videoCandidates.length || /\/status\/\d+\/video\//.test(location.pathname))) {
      return [{
        type: "video",
        url: videoCandidates[0] || "",
        thumbnail: findFallbackVideoThumbnail(root),
        candidates: videoCandidates
      }];
    }

    return sortedItems;
  }

  /** Find the best thumbnail URL for a video element. */
  function findVideoThumbnail(video) {
    if (video?.poster) {
      return stripImageSizeParams(video.poster);
    }

    return findFallbackVideoThumbnail(video?.closest("article") || document);
  }

  function findFallbackVideoThumbnail(root = document) {
    // X often renders the video poster as a nearby twimg image rather than video.poster.
    const image = Array.from(root.querySelectorAll('img[src*="twimg.com"]'))
      .filter(isVisible)
      .find((candidate) => /(?:ext_tw_video_thumb|amplify_video_thumb|media)/.test(candidate.src));

    return image?.src ? stripImageSizeParams(image.src) : "";
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

  function getElementOrder(element) {
    const rect = element.getBoundingClientRect();
    return rect.top * 100000 + rect.left;
  }

  function findVisibleElements(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).filter(isVisible);
  }

  /** Extract downloadable video source URLs from a <video> element. */
  function collectVideoCandidates(video) {
    const candidates = [];

    if (video?.currentSrc) {
      candidates.push(video.currentSrc);
    }

    if (video?.src) {
      candidates.push(video.src);
    }

    video?.querySelectorAll("source[src]")?.forEach((source) => {
      candidates.push(source.src);
    });

    performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(isTwitterVideoResource)
      .forEach((url) => candidates.push(url));

    findTwitterVideoUrlsInPage().forEach((url) => candidates.push(url));

    return [...new Set(candidates.map(cleanEscapedUrl))]
      .filter((url) => url && !url.startsWith("blob:"))
      .sort(rankVideoCandidate);
  }

  function isTwitterVideoResource(url) {
    return url.includes("video.twimg.com") && (
      url.includes(".mp4") ||
      url.includes(".m3u8")
    );
  }

  /** Scan the page for twitter video URLs captured via webRequest. */
  function findTwitterVideoUrlsInPage() {
    const html = document.documentElement.innerHTML;
    const matches = html.match(/https?:[\\/]+video\.twimg\.com[\\/]+[^"'<\s]+?(?:\.mp4|\.m3u8)(?:\?[^"'<\s]*)?/g) || [];
    return matches;
  }

  function cleanEscapedUrl(url) {
    return url
      .replaceAll("\\/", "/")
      .replaceAll("&amp;", "&")
      .replace(/\\u0026/g, "&");
  }

  function rankVideoCandidate(a, b) {
    const aIsMp4 = a.includes(".mp4") ? 1 : 0;
    const bIsMp4 = b.includes(".mp4") ? 1 : 0;

    if (aIsMp4 !== bIsMp4) {
      return bIsMp4 - aIsMp4;
    }

    return getVideoCandidatePixels(b) - getVideoCandidatePixels(a);
  }

  function getVideoCandidatePixels(url) {
    const match = url.match(/\/(\d+)x(\d+)\//);
    return match ? Number(match[1]) * Number(match[2]) : 0;
  }

  function findVisibleElement(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).find(isVisible) || null;
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
    button.innerHTML = label === LABEL_SENT ? ICON_SENT : ICON_READY;
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