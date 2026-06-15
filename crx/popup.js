(function () {
  const openOptionsButton = document.getElementById("open-options");
  const backToQueueButton = document.getElementById("back-to-queue");
  const headerMain = document.getElementById("header-main");
  const headerSettings = document.getElementById("header-settings");
  const queueView = document.getElementById("view-queue");
  const queueTabs = document.getElementById("queue-tabs");
  const settingsView = document.getElementById("view-settings");
  const queueList = document.getElementById("queue-list");
  const queuePagination = document.getElementById("queue-pagination");
  const extensionName = document.getElementById("extension-name");
  const configList = document.getElementById("config-list");
  const newConfigButton = document.getElementById("new-config");
  const form = document.getElementById("settings-form");
  const configIdInput = document.getElementById("config-id");
  const noteInput = document.getElementById("config-note");
  const botTokenInput = document.getElementById("bot-token");
  const chatIdInput = document.getElementById("chat-id");
  const settingsStatus = document.getElementById("settings-status");
  const keepCompletedItemsInput = document.getElementById("keep-completed-items");
  const languageSelect = document.getElementById("language-select");
  const maxCompletedItemsRow = document.getElementById("max-completed-items-row");
  const maxCompletedItemsSelect = document.getElementById("max-completed-items");
  const forwardEndpointRow = document.getElementById("forward-endpoint-row");
  const forwardEndpointHost = document.getElementById("forward-endpoint-host");
  const clearForwardEndpointButton = document.getElementById("clear-forward-endpoint");

  const QUEUE_KEY = "forwardQueue";
  const GENERAL_SETTINGS_KEY = "generalSettings";
  const QUEUE_ITEMS_PER_PAGE = 5;
  const DEFAULT_GENERAL_SETTINGS = {
    keepCompletedItems: false,
    maxCompletedItems: 5,
    endpointUrl: "",
    endpointSetupUrl: "",
    endpointKey: ""
  };
  const ALLOWED_COMPLETED_RECORD_COUNTS = [5, 10, 30];

  let configs = [];
  let currentQueue = [];
  let activeQueueFilter = "all";
  let queueCurrentPage = 0;
  let lastQueueSignature = "";
  let draggedConfigItem = null;
  let snapEndTime = 0;
  const SNAP_DURATION_MS = 290;

  if (extensionName) {
    extensionName.textContent = chrome.runtime.getManifest().name;
  }

  openOptionsButton.addEventListener("click", () => {
    showSettings();
  });

  backToQueueButton.addEventListener("click", () => {
    showQueue();
  });

  newConfigButton.addEventListener("click", () => {
    editConfig(null);
  });

  keepCompletedItemsInput.addEventListener("change", async () => {
    syncGeneralSettingsControls();
    await saveGeneralSettings();
  });

  maxCompletedItemsSelect.addEventListener("change", async () => {
    await saveGeneralSettings();
  });

  clearForwardEndpointButton.addEventListener("click", async () => {
    clearForwardEndpointButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CLEAR_FORWARD_ENDPOINT" });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_clearEndpointFailed"));
      }

      applyGeneralSettings(response.result);
      setSettingsStatus("");
    } catch (error) {
      setSettingsStatus(error.message || String(error), true);
    } finally {
      clearForwardEndpointButton.disabled = false;
    }
  });


  // ==================== Settings ====================
  /** Persist general settings to chrome.storage and apply them. */
  async function saveGeneralSettings() {
    try {
      const currentSettings = await readGeneralSettings();
      const settings = normalizeGeneralSettings({
        keepCompletedItems: keepCompletedItemsInput.checked,
        maxCompletedItems: Number(maxCompletedItemsSelect.value),
        endpointUrl: currentSettings.endpointUrl,
        endpointSetupUrl: currentSettings.endpointSetupUrl,
        endpointKey: currentSettings.endpointKey
      });

      await chrome.storage.sync.set({ [GENERAL_SETTINGS_KEY]: settings });
      if (settings.keepCompletedItems) {
        await trimCompletedQueueItems(settings.maxCompletedItems);
      } else {
        await clearCompletedQueueItems();
      }

      applyGeneralSettings(settings);
      currentQueue = await getVisibleQueueFromStorage(settings);
      lastQueueSignature = "";
      renderQueue();
      setSettingsStatus("");
    } catch (error) {
      await restoreGeneralSettingsControls();
      setSettingsStatus(error.message || String(error), true);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const config = {
      id: configIdInput.value.trim(),
      note: noteInput.value.trim(),
      botToken: botTokenInput.value.trim(),
      chatId: chatIdInput.value.trim()
    };

    if (!config.note || !config.chatId || (!config.id && !config.botToken)) {
      setSettingsStatus(Save2TG.I18n.t("popup_saveConfigFailed"), true);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: "SAVE_TELEGRAM_CONFIG", config });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_err_saveConfigFailed"));
      }

      configs = response.result || [];
      renderConfigs();
      const saved = config.id
        ? configs.find((entry) => entry.id === config.id)
        : configs[configs.length - 1];
      editConfig(saved || configs[0] || null, { keepToken: true });
      setSettingsStatus("");
    } catch (error) {
      setSettingsStatus(error.message || String(error), true);
    }
  });

  configList.addEventListener("click", (event) => {
    const deleteBtn = event.target instanceof Element ? event.target.closest("[data-action='delete-config']") : null;
    if (deleteBtn) {
      event.stopPropagation();
      deleteConfigById(deleteBtn.dataset.configId);
      return;
    }

    const item = event.target instanceof Element ? event.target.closest("button[data-config-id]") : null;
    if (!item) {
      return;
    }

    editConfig(configs.find((config) => config.id === item.dataset.configId) || null);
  });

  configList.addEventListener("dragover", (event) => {
    if (!draggedConfigItem) {
      return;
    }

    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = "move";
    } catch (_) { }

    const reference = getConfigDropReference(event.clientY);
    moveConfigItemBefore(draggedConfigItem, reference);
  });

  configList.addEventListener("drop", (event) => {
    if (draggedConfigItem) {
      event.preventDefault();
    }
  });

  queueList.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!button) {
      return;
    }

    const id = button.dataset.id;
    const action = button.dataset.action;
    const type = action === "retry" ? "RETRY_FORWARD_QUEUE_ITEM" : "REMOVE_FORWARD_QUEUE_ITEM";
    button.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ type, id });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_queueOpFailed"));
      }

      currentQueue = response.result || [];
      renderQueue();
    } catch (error) {
      renderError(error.message || String(error));
    }
  });

  queueTabs.addEventListener("click", (event) => {
    const tab = event.target instanceof Element ? event.target.closest("[data-filter]") : null;
    if (!tab || tab.dataset.filter === activeQueueFilter) {
      return;
    }

    activeQueueFilter = tab.dataset.filter || "all";
    queueCurrentPage = 0;
    queueTabs.querySelectorAll(".queue-tab").forEach((button) => {
      const isActive = button.dataset.filter === activeQueueFilter;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    lastQueueSignature = "";
    renderQueue();
  });

  window.addEventListener("resize", () => {
    syncTooltipAnchors();
    syncQueueTooltipAnchors();
  });
  queueList.addEventListener("scroll", syncQueueTooltipAnchors);
  queueList.addEventListener("mouseover", (event) => {
    if (event.target instanceof Element && event.target.closest(".queue-error-trigger")) {
      syncQueueTooltipAnchors();
    }
  });
  queueList.addEventListener("focusin", (event) => {
    if (event.target instanceof Element && event.target.closest(".queue-error-trigger")) {
      syncQueueTooltipAnchors();
    }
  });

  Save2TG.I18n.init().then(() => {
    Save2TG.I18n.applyDom();
    setupLanguageSwitcher();
    loadQueue();
    loadGeneralSettings();
    loadConfigs();
    setupQueueListWheel();
  }).catch(() => {
    loadQueue();
    loadGeneralSettings();
    loadConfigs();
    setupQueueListWheel();
  });
  setInterval(loadQueue, 2500);

  /** Initialize the language selector dropdown with the stored preference. */
  async function setupLanguageSwitcher() {
    if (!languageSelect) {
      return;
    }

    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(Save2TG.I18n.STORAGE_KEY, (result) => {
        resolve(result?.[Save2TG.I18n.STORAGE_KEY] || "auto");
      });
    });
    languageSelect.value = ["auto", "en", "zh_CN"].includes(stored) ? stored : "auto";

    languageSelect.addEventListener("change", async () => {
      await Save2TG.I18n.setLocale(languageSelect.value);
      await Save2TG.I18n.init();
      Save2TG.I18n.applyDom();
      refreshLocalizedDynamicContent();
    });
  }

  /** Re-apply i18n to DOM elements when locale changes. */
  function refreshLocalizedDynamicContent() {
    const submitBtn = form.querySelector("button[type='submit']");
    if (submitBtn) {
      submitBtn.textContent = configIdInput.value ? Save2TG.I18n.t("popup_save") : Save2TG.I18n.t("popup_add");
    }

    renderConfigs();
    lastQueueSignature = "";
    renderQueue();
    syncTooltipAnchors();
    syncQueueTooltipAnchors();
  }

  /** Switch to the settings panel view. */
  function showSettings() {
    headerMain.classList.add("hidden");
    queueView.classList.add("hidden");
    headerSettings.classList.remove("hidden");
    settingsView.classList.remove("hidden");
    loadGeneralSettings();
    loadConfigs();
    requestAnimationFrame(syncTooltipAnchors);
  }

  /** Switch to the queue panel view. */
  function showQueue() {

    // ==================== Configuration Management ====================
    headerSettings.classList.add("hidden");
    settingsView.classList.add("hidden");
    headerMain.classList.remove("hidden");
    queueView.classList.remove("hidden");
  }

  /** Load Telegram configurations from the service worker. */
  async function loadConfigs() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_TELEGRAM_CONFIGS" });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_readConfigFailed"));
      }

      configs = response.result || [];
      renderConfigs();
      if (!configIdInput.value) {
        editConfig(configs[0] || null);
      }
    } catch (error) {
      setSettingsStatus(error.message || String(error), true);
    }
  }

  /** Load general settings from chrome.storage. */
  async function loadGeneralSettings() {
    try {
      applyGeneralSettings(await readGeneralSettings());
    } catch (error) {
      setSettingsStatus(Save2TG.I18n.t("popup_err_readSettingsFailed", [error.message || String(error)]), true);
    }
  }

  async function restoreGeneralSettingsControls() {
    try {
      applyGeneralSettings(await readGeneralSettings());
    } catch (_) {
      applyGeneralSettings(DEFAULT_GENERAL_SETTINGS);
    }
  }

  async function readGeneralSettings() {
    const data = await chrome.storage.sync.get(GENERAL_SETTINGS_KEY);
    return normalizeGeneralSettings(data[GENERAL_SETTINGS_KEY]);
  }

  /** Normalize settings with defaults for any missing fields. */
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

  /** Apply general settings to the UI controls. */
  function applyGeneralSettings(settings) {
    const normalized = normalizeGeneralSettings(settings);
    keepCompletedItemsInput.checked = normalized.keepCompletedItems;
    maxCompletedItemsSelect.value = String(normalized.maxCompletedItems);
    syncGeneralSettingsControls();
    syncForwardEndpointControls(normalized.endpointUrl, normalized.endpointSetupUrl);
  }

  function syncGeneralSettingsControls() {
    maxCompletedItemsRow.classList.toggle("hidden", !keepCompletedItemsInput.checked);
  }

  function syncForwardEndpointControls(endpointUrl, endpointSetupUrl = "") {
    const normalized = normalizeEndpointUrl(endpointUrl);
    forwardEndpointRow.classList.toggle("hidden", !normalized);
    forwardEndpointHost.textContent = normalized ? new URL(normalized).host : "";
    const setupUrl = normalizeSetupUrl(endpointSetupUrl) || normalized;
    if (normalized && setupUrl) {
      forwardEndpointHost.href = setupUrl;
      forwardEndpointHost.title = setupUrl;
    } else {
      forwardEndpointHost.removeAttribute("href");
      forwardEndpointHost.removeAttribute("title");
    }
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

  /** Read the raw forward queue from chrome.storage.local. */
  async function getQueueFromStorage() {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
  }

  /** Read and filter the queue based on current settings. */
  async function getVisibleQueueFromStorage(settings = null) {
    const [queue, resolvedSettings] = await Promise.all([
      getQueueFromStorage(),
      settings ? Promise.resolve(normalizeGeneralSettings(settings)) : readGeneralSettings()
    ]);

    return resolvedSettings.keepCompletedItems ? queue : queue.filter((item) => item.status !== "sent");
  }

  /** Remove all completed (sent) items from the queue. */
  async function clearCompletedQueueItems() {
    const queue = await getQueueFromStorage();
    await chrome.storage.local.set({
      [QUEUE_KEY]: queue.filter((item) => item.status !== "sent")
    });
  }


  // ==================== Config Rendering ====================
  /** Trim completed queue items to the given max count. */
  async function trimCompletedQueueItems(maxCount) {
    const limit = ALLOWED_COMPLETED_RECORD_COUNTS.includes(Number(maxCount))
      ? Number(maxCount)
      : DEFAULT_GENERAL_SETTINGS.maxCompletedItems;
    const queue = await getQueueFromStorage();
    const completed = queue
      .filter((item) => item.status === "sent")
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const keptCompletedIds = new Set(completed.slice(0, limit).map((item) => item.id));
    await chrome.storage.local.set({
      [QUEUE_KEY]: queue.filter((item) => item.status !== "sent" || keptCompletedIds.has(item.id))
    });
  }

  /** Render the list of Telegram configurations. */
  function renderConfigs() {
    configList.replaceChildren();

    if (!configs.length) {
      const empty = document.createElement("p");
      empty.className = "config-empty";
      empty.textContent = Save2TG.I18n.t("popup_noConfigs");
      configList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    configs
      .slice()
      .forEach((config) => fragment.append(createConfigItem(config)));
    configList.append(fragment);
    syncTooltipAnchors();
  }

  /** Create a DOM element for a single Telegram configuration. */
  function createConfigItem(config) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "config-item";
    button.dataset.configId = config.id;
    button.dataset.active = config.id === configIdInput.value ? "true" : "false";

    const dragHandle = document.createElement("span");
    dragHandle.className = "config-item-drag";
    dragHandle.draggable = true;
    dragHandle.setAttribute("aria-hidden", "true");
    dragHandle.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1"/><circle cx="11" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/></svg>';


    const main = document.createElement("div");
    main.className = "config-item-main";

    const note = document.createElement("span");
    note.className = "config-item-note";
    note.textContent = config.note || config.chatId || Save2TG.I18n.t("popup_unnamedConfig");

    const chatId = document.createElement("span");
    chatId.className = "config-item-chatid";
    chatId.textContent = config.note ? config.chatId : "";

    main.append(note, chatId);

    const deleteBtn = document.createElement("span");
    deleteBtn.className = "config-item-delete";
    deleteBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    deleteBtn.setAttribute("aria-label", Save2TG.I18n.t("popup_delete"));
    deleteBtn.dataset.action = "delete-config";
    deleteBtn.dataset.configId = config.id;

    button.append(dragHandle, main, deleteBtn);
    wireConfigItemDrag(button, dragHandle);
    return button;
  }

  /** Enable drag-and-drop reordering for a config item. */
  function wireConfigItemDrag(item, handle) {
    handle.addEventListener("dragstart", (event) => {
      draggedConfigItem = item;
      item.classList.add("dragging");
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", "config-item");
      } catch (_) { }
    });

    handle.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      saveConfigOrder();
      draggedConfigItem = null;
    });
  }

  function getConfigDropReference(clientY) {
    const items = [...configList.querySelectorAll(".config-item[data-config-id]:not(.dragging)")];
    return items.find((item) => {
      const rect = item.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    }) || null;
  }

  function moveConfigItemBefore(item, reference) {
    if (reference === item || reference === item.nextSibling) {
      return;
    }

    configList.insertBefore(item, reference);
  }

  /** Persist the reordered configuration list. */
  async function saveConfigOrder() {
    const ids = [...configList.querySelectorAll(".config-item[data-config-id]")]

      // ==================== Config Editor ====================
      .map((item) => item.dataset.configId)
      .filter(Boolean);

    if (!ids.length || ids.join("\n") === configs.map((config) => config.id).join("\n")) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: "REORDER_TELEGRAM_CONFIGS", ids });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_err_saveOrderFailed"));
      }

      configs = response.result || [];
      renderConfigs();
    } catch (error) {
      setSettingsStatus(error.message || String(error), true);
      renderConfigs();
    }
  }

  /** Open the config editor for a new or existing configuration. */
  function editConfig(config, options = {}) {
    configIdInput.value = config?.id || "";
    noteInput.value = config?.note || "";
    botTokenInput.value = options.keepToken ? botTokenInput.value : "";
    chatIdInput.value = config?.chatId || "";
    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.textContent = config?.id ? Save2TG.I18n.t("popup_save") : Save2TG.I18n.t("popup_add");
    setSettingsStatus("");
    renderConfigs();
    syncTooltipAnchors();
  }

  function syncTooltipAnchors() {
    document.querySelectorAll(".info-icon").forEach((icon) => {
      const row = icon.closest("#settings-form label");
      if (!row) {
        return;
      }

      const iconRect = icon.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (!iconRect.width || !rowRect.width) {
        return;
      }

      const cx = iconRect.left + iconRect.width / 2 - rowRect.left;
      row.style.setProperty("--info-icon-x", `${cx.toFixed(1)}px`);
    });
  }

  /** Delete a Telegram configuration by ID. */
  async function deleteConfigById(id) {
    if (!id) {

      // ==================== Queue ====================
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: "DELETE_TELEGRAM_CONFIG", id });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_deleteConfigFailed"));
      }

      configs = response.result || [];
      renderConfigs();
      editConfig(configs[0] || null);
      setSettingsStatus("");

      // ==================== Queue Rendering ====================
    } catch (error) {
      setSettingsStatus(error.message || String(error), true);
    }
  }

  /** Display a status message in the settings area. */
  function setSettingsStatus(message, isError = false) {
    settingsStatus.textContent = message;
    settingsStatus.className = isError ? "settings-status error" : "settings-status";
    settingsStatus.classList.toggle("hidden", !message);
  }

  /** Load and render the forward queue. */
  async function loadQueue() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_FORWARD_QUEUE" });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_readQueueFailed"));
      }

      currentQueue = response.result || [];
      renderQueue();
    } catch (error) {
      renderError(error.message || String(error));
    }
  }

  /** Render the forward queue from current visible items. */
  function renderQueue() {
    const visibleQueue = getFilteredQueue(currentQueue);
    const sortedQueue = visibleQueue
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const totalPages = Math.ceil(sortedQueue.length / QUEUE_ITEMS_PER_PAGE);

    if (totalPages > 0 && queueCurrentPage >= totalPages) {
      queueCurrentPage = totalPages - 1;
    }

    if (queueCurrentPage < 0) {
      queueCurrentPage = 0;
    }

    const signature = JSON.stringify({
      filter: activeQueueFilter,
      page: queueCurrentPage,
      queue: sortedQueue.map(getQueueRenderSignature)
    });

    if (signature === lastQueueSignature) {
      return;
    }

    lastQueueSignature = signature;

    if (!sortedQueue.length) {
      queueList.replaceChildren();
      renderQueuePagination(0, 0);
      const empty = document.createElement("p");
      empty.className = "queue-empty";
      empty.textContent = getQueueEmptyText();
      queueList.append(empty);
      return;
    }

    queueList.replaceChildren();

    const track = document.createElement("div");
    track.className = "queue-track dragging";

    for (let page = 0; page < totalPages; page += 1) {
      const pageEl = document.createElement("div");
      pageEl.className = "queue-page";
      const start = page * QUEUE_ITEMS_PER_PAGE;
      sortedQueue
        .slice(start, start + QUEUE_ITEMS_PER_PAGE)
        .forEach((item) => pageEl.append(createQueueItem(item)));
      track.append(pageEl);
    }

    queueList.append(track);
    setTrackTransform(track, queueCurrentPage, 0);
    void track.offsetWidth;
    track.classList.remove("dragging");
    // Anchor call: .queue-track transform makes position:fixed inside the
    // track relative to the track, not the viewport. syncQueueTooltipAnchors
    // must recompute after each layout change that affects the track or
    // its items (render, page-nav, resize, scroll, hover).
    renderQueuePagination(totalPages, queueCurrentPage);

    requestAnimationFrame(syncQueueTooltipAnchors);
  }

  /** Render pagination controls for the queue. */
  function renderQueuePagination(totalPages, currentPage) {
    queuePagination.replaceChildren();
    if (totalPages <= 1) {
      queuePagination.classList.add("hidden");
      return;
    }

    queuePagination.classList.remove("hidden");
    for (let page = 0; page < totalPages; page += 1) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `queue-dot${page === currentPage ? " active" : ""}`;
      dot.dataset.page = String(page);
      dot.title = Save2TG.I18n.t("popup_page", [page + 1]);
      dot.setAttribute("aria-label", Save2TG.I18n.t("popup_page", [page + 1]));
      dot.addEventListener("click", () => {
        if (queueCurrentPage === page) return;
        goToQueuePage(page);
      });
      queuePagination.append(dot);
    }
  }

  /** Navigate to a specific queue page. */
  function goToQueuePage(page) {
    const track = queueList.querySelector(".queue-track");
    if (!track) {
      return;
    }

    queueCurrentPage = page;
    track.classList.remove("dragging");
    void track.offsetWidth;
    setTrackTransform(track, page, 0);
    syncQueuePaginationDots();
    // Must recalc tooltip anchors: the transform change shifts the
    // containing block for position:fixed inside the track.
    requestAnimationFrame(syncQueueTooltipAnchors);
    snapEndTime = Date.now() + SNAP_DURATION_MS;
  }

  function setTrackTransform(track, page, offset) {
    track.style.transform = `translateX(calc(${-page * 100}% - ${offset}px))`;
  }

  function syncQueuePaginationDots(activeIdx) {
    if (activeIdx === undefined) activeIdx = queueCurrentPage;
    queuePagination.querySelectorAll(".queue-dot").forEach((dot, index) => {
      dot.classList.toggle("active", index === activeIdx);
    });
  }

  // Wheel / two-finger swipe pagination with live drag tracking.
  /** Enable horizontal wheel scrolling on the queue list. */
  function setupQueueListWheel() {
    const COMMIT_RATIO = 0.3;
    const RUBBER = 0.35;
    const END_DELAY_MS = 120;
    const WHEEL_CLICK_MIN = 50;
    const WHEEL_COOLDOWN_MS = 220;

    let dragOffset = 0;
    let endTimer = null;
    let wheelCooldownUntil = 0;

    queueList.addEventListener("wheel", (e) => {
      const visibleQueue = getFilteredQueue(currentQueue);
      const sortedQueue = visibleQueue.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const totalPages = Math.ceil(sortedQueue.length / QUEUE_ITEMS_PER_PAGE);
      if (totalPages <= 1) return;

      const track = queueList.querySelector(".queue-track");
      if (!track) return;

      e.preventDefault();

      const width = queueList.clientWidth;
      if (!width) return;

      const isWheelClick = e.deltaMode !== 0
        || (e.deltaX === 0 && Math.abs(e.deltaY) >= WHEEL_CLICK_MIN);

      if (isWheelClick) {
        const now = Date.now();
        if (now < wheelCooldownUntil) return;

        const dir = e.deltaY > 0 ? 1 : -1;
        const target = queueCurrentPage + dir;
        if (target < 0 || target >= totalPages) return;

        dragOffset = 0;
        if (endTimer) { clearTimeout(endTimer); endTimer = null; }
        wheelCooldownUntil = now + WHEEL_COOLDOWN_MS;
        goToQueuePage(target);
        return;
      }

      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      let next = dragOffset + raw;
      const atStart = queueCurrentPage === 0 && next < 0;
      const atEnd = queueCurrentPage === totalPages - 1 && next > 0;
      if (atStart || atEnd) next *= RUBBER;

      if (next >= width || next <= -width) {
        const dir = next >= width ? 1 : -1;
        const target = queueCurrentPage + dir;
        if (target >= 0 && target < totalPages) {
          dragOffset = 0;
          if (endTimer) { clearTimeout(endTimer); endTimer = null; }
          goToQueuePage(target);
          return;
        }
        next = next > 0 ? width : -width;
      }
      dragOffset = next;

      if (Date.now() >= snapEndTime) track.classList.add("dragging");
      setTrackTransform(track, queueCurrentPage, dragOffset);

      const visualIdx = Math.max(0, Math.min(totalPages - 1,
        Math.round(queueCurrentPage + dragOffset / width)));
      syncQueuePaginationDots(visualIdx);

      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => {

        // ==================== Queue Item Rendering ====================
        const threshold = width * COMMIT_RATIO;
        let target = queueCurrentPage;
        if (dragOffset > threshold && target < totalPages - 1) target++;
        else if (dragOffset < -threshold && target > 0) target--;
        dragOffset = 0;
        goToQueuePage(target);
      }, END_DELAY_MS);
    }, { passive: false });
  }

  /** Filter queue by the active tab filter (all/active/error). */
  function getFilteredQueue(queue) {
    if (activeQueueFilter === "active") {
      return queue.filter((item) => item.status === "pending" || item.status === "sending");
    }

    if (activeQueueFilter === "error") {
      return queue.filter((item) => item.status === "error");
    }

    return queue;
  }

  /** Get the appropriate empty-state text for the current filter. */
  function getQueueEmptyText() {
    const labels = {
      all: Save2TG.I18n.t("popup_queueEmptyAll"),
      active: Save2TG.I18n.t("popup_queueEmptyActive"),
      error: Save2TG.I18n.t("popup_queueEmptyError")
    };

    return labels[activeQueueFilter] || labels.all;
  }

  /** Create a DOM element for a single queue item card. */
  function createQueueItem(item) {
    const article = document.createElement("article");
    article.dataset.id = item.id;
    article.dataset.structureSignature = getQueueStructureSignature(item);
    article.className = `queue-item status-${item.status || "pending"} phase-${item.phase || "pending"}`;
    article.style.setProperty("--progress", `${getProgress(item)}%`);

    const icon = createMediaIcon(item);
    const main = document.createElement("div");
    main.className = "queue-main";

    const title = document.createElement("a");
    title.className = "queue-title";
    title.href = item.payload?.tweetUrl || "#";
    title.target = "_blank";
    title.rel = "noreferrer";
    title.textContent = item.payload?.text || item.payload?.tweetUrl || Save2TG.I18n.t("popup_untitledTweet");

    const subLine1 = document.createElement("span");
    subLine1.className = "queue-sub-line";
    subLine1.textContent = [
      item.telegramConfigLabel || "",
      formatTime(item.createdAt)
    ].filter(Boolean).join(" · ");

    const subLine2 = document.createElement("span");
    subLine2.className = "queue-sub-line";
    renderQueueSubLine2(subLine2, item);
    main.append(title, subLine1, subLine2);

    const status = document.createElement("div");
    status.className = "queue-status";

    const phase = document.createElement("span");
    phase.className = "queue-phase";
    phase.textContent = getPhaseLabel(item);

    const infoBottom = document.createElement("div");
    infoBottom.className = "queue-info-bottom";

    const percent = item.status === "error" ? document.createElement("button") : document.createElement("span");
    percent.className = item.status === "error" ? "queue-percent retry-inline" : "queue-percent";

    if (item.status === "error") {
      percent.type = "button";
      percent.innerHTML = '<svg viewBox="0 0 1024 1024"><path d="M512 128a382.293333 382.293333 0 0 0-291.584 135.082667L128 170.666667v256h256L281.258667 323.925333C336 256.725333 418.773333 213.333333 512 213.333333c164.650667 0 298.666667 133.973333 298.666667 298.666667h85.333333c0-211.712-172.245333-384-384-384z m-384 384c0 211.754667 172.245333 384 384 384a382.293333 382.293333 0 0 0 291.584-135.082667L896 853.333333v-256h-256l102.741333 102.741334C688 767.274667 605.226667 810.666667 512 810.666667c-164.650667 0-298.666667-134.016-298.666667-298.666667H128z" fill="#3F3F3F" p-id="7271"></path></svg>';
      percent.dataset.action = "retry";
      percent.dataset.id = item.id;
      percent.title = Save2TG.I18n.t("popup_retry");
      percent.setAttribute("aria-label", Save2TG.I18n.t("popup_retry"));
    } else {
      percent.textContent = `${getProgress(item)}%`;
      percent.classList.toggle("hidden", !shouldShowQueuePercent(item));
    }

    const deleteBtn = createQueueRemoveButton(item);

    infoBottom.append(percent, deleteBtn);
    status.append(phase, infoBottom);

    article.append(icon, main, status);
    return article;
  }

  /** Update an existing queue item DOM element with new data. */
  function updateQueueItem(article, item) {
    article.className = `queue-item status-${item.status || "pending"} phase-${item.phase || "pending"}`;
    article.style.setProperty("--progress", `${getProgress(item)}%`);

    const phase = article.querySelector(".queue-phase");
    if (phase) {
      phase.textContent = getPhaseLabel(item);
    }

    const percent = article.querySelector(".queue-percent:not(.retry-inline)");
    if (percent) {
      percent.textContent = `${getProgress(item)}%`;
      percent.classList.toggle("hidden", !shouldShowQueuePercent(item));
    }

    const removeBtn = article.querySelector(".queue-item-delete");
    if (removeBtn) {
      updateQueueRemoveButton(removeBtn, item);
    }

    const subLines = article.querySelectorAll(".queue-sub-line");
    if (subLines[1]) {
      renderQueueSubLine2(subLines[1], item);
    }
  }

  /** Create a remove/delete button for a queue item. */
  function createQueueRemoveButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "queue-item-delete";
    button.dataset.action = "remove";
    button.dataset.id = item.id;
    updateQueueRemoveButton(button, item);
    return button;
  }

  function updateQueueRemoveButton(button, item) {
    const isSent = item.status === "sent";
    button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    button.title = isSent ? Save2TG.I18n.t("popup_delete") : Save2TG.I18n.t("popup_cancel");
    button.setAttribute("aria-label", isSent ? Save2TG.I18n.t("popup_delete") : Save2TG.I18n.t("popup_cancel"));
  }

  /** Render the second sub-line of a queue item (phase/time/error details). */
  function renderQueueSubLine2(element, item) {
    element.replaceChildren();

    const details = [
      getMediaSummary(item),
      formatBytes(item.bytesTotal || item.bytesLoaded || 0),
    ].filter(Boolean);

    if (details.length) {
      element.append(document.createTextNode(details.join(" · ")));
    }

    if (item.status === "error" && item.lastError) {
      if (details.length) {
        element.append(document.createTextNode(" "));
      }

      const errTrigger = document.createElement("span");
      errTrigger.className = "queue-error-trigger";
      errTrigger.setAttribute("data-tooltip", item.lastError);
      errTrigger.setAttribute("tabindex", "0");
      errTrigger.setAttribute("aria-label", item.lastError);

      const errIcon = document.createElement("span");
      errIcon.className = "queue-error-icon";
      errIcon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><line x1="8" y1="4.5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none"/></svg>';

      const errLabel = document.createElement("span");
      errLabel.className = "queue-error-label";
      errLabel.textContent = Save2TG.I18n.t("popup_failed");

      errTrigger.append(errIcon, errLabel);
      element.append(errTrigger);
    }

    if (item.status === "sent") {
      if (details.length) {
        element.append(document.createTextNode(" "));
      }

      const doneLabel = document.createElement("span");
      doneLabel.className = "queue-done-label";
      doneLabel.textContent = Save2TG.I18n.t("popup_done");
      element.append(doneLabel);
    }
  }

  /* Recalculate tooltip anchor positions for error-state items.
   *
   * .queue-track uses transform:translateX for pagination, which means
   * every position:fixed descendant is relative to the track's transform
   * container, NOT the viewport. Therefore ALL coordinates derived from
   * getBoundingClientRect() MUST be normalized by subtracting the track's
   * own bbox origin. If the transform ancestor changes, the normalisation
   * formula changes too.
   *
   * Call-sites that must trigger a re-anchor:
   *   - renderQueue()       (rAF, after initial layout)
   *   - goToQueuePage()     (rAF, after transform change)
   *   - window resize       (direct)
   *   - queueList scroll    (direct)
   *   - mouseover / focusin on .queue-error-trigger (direct) */
  function syncQueueTooltipAnchors() {
    const track = queueList.querySelector(".queue-track");
    if (!track) return;
    const trackRect = track.getBoundingClientRect();
    const popupWidth = document.body.getBoundingClientRect().width || 320;
    const bodyStyles = getComputedStyle(document.body);
    const gutter = parseFloat(bodyStyles.getPropertyValue("--tooltip-popup-gutter")) || 14;
    const arrowSize = parseFloat(bodyStyles.getPropertyValue("--tooltip-arrow-size")) || 6;
    const arrowHalfWidth = parseFloat(bodyStyles.getPropertyValue("--tooltip-arrow-half-width")) || 5;
    const arrowOverlap = 1;
    const minViewportLeft = gutter;
    const maxViewportRight = popupWidth - gutter;

    document.querySelectorAll(".queue-error-trigger").forEach((trigger) => {
      const triggerRect = trigger.getBoundingClientRect();
      if (!triggerRect.width) return;

      // Visual styling stays in CSS pseudo-elements. JS only supplies
      // geometry because .queue-track is transformed for pagination, making
      // position:fixed descendants track-relative instead of viewport-relative.
      const triggerCenterX = triggerRect.left + triggerRect.width / 2;
      const tooltipText = trigger.getAttribute("data-tooltip") || "";
      const maxWidth = Math.min(276, Math.max(120, maxViewportRight - minViewportLeft));
      const tooltipWidth = measureQueueTooltipWidth(tooltipText, maxWidth);

      const centeredLeft = triggerCenterX - tooltipWidth / 2;
      const viewportLeft = Math.min(
        maxViewportRight - tooltipWidth,
        Math.max(minViewportLeft, centeredLeft)
      );

      // Bubble bottom sits just above the trigger; the arrow starts 1px above
      // that bottom edge so the triangle touches the bubble with no gap.
      const tooltipBottom = triggerRect.top - arrowSize + arrowOverlap;
      const left = viewportLeft - trackRect.left;
      const top = tooltipBottom - trackRect.top;
      const arrowLeft = Math.min(
        viewportLeft + tooltipWidth - arrowHalfWidth,
        Math.max(viewportLeft + arrowHalfWidth, triggerCenterX)
      ) - trackRect.left;

      trigger.style.setProperty("--queue-tooltip-left", `${left.toFixed(1)}px`);
      trigger.style.setProperty("--queue-tooltip-top", `${top.toFixed(1)}px`);
      trigger.style.setProperty("--queue-tooltip-arrow-left", `${arrowLeft.toFixed(1)}px`);
      trigger.style.setProperty("--queue-tooltip-width", `${tooltipWidth.toFixed(1)}px`);
      trigger.style.setProperty("--queue-tooltip-max-width", `${maxWidth.toFixed(1)}px`);

      // Keep the tooltip as CSS pseudo-elements; no body-level float is used.
    });
  }

  function measureQueueTooltipWidth(text, maxWidth) {
    const measure = document.createElement("div");
    measure.className = "queue-tooltip-measure";
    measure.textContent = text;
    measure.style.width = `${maxWidth}px`;
    document.body.append(measure);

    const targetHeight = measure.getBoundingClientRect().height;
    let low = 80;
    let high = maxWidth;
    for (let i = 0; i < 8; i += 1) {
      const mid = (low + high) / 2;
      measure.style.width = `${mid}px`;
      if (measure.getBoundingClientRect().height <= targetHeight) {
        high = mid;
      } else {
        low = mid;
      }
    }

    measure.style.width = `${high}px`;
    const width = Math.ceil(measure.getBoundingClientRect().width);
    measure.remove();
    return Math.max(0, Math.min(maxWidth, width));
  }

  function getQueueRenderSignature(item) {
    return {
      id: item.id,
      status: item.status,
      phase: item.phase,
      progress: getProgress(item),
      bytesLoaded: item.bytesLoaded || 0,
      bytesTotal: item.bytesTotal || 0,
      lastError: item.lastError || "",
      title: item.payload?.text || item.payload?.tweetUrl || "",
      tweetUrl: item.payload?.tweetUrl || "",
      config: item.telegramConfigLabel || "",
      createdAt: item.createdAt || 0,
      media: getMediaSummary(item),
      thumbnail: getMediaThumbnail(item)
    };
  }

  function getQueueStructureSignature(item) {

    // ==================== Utility Functions ====================
    return JSON.stringify({
      id: item.id,
      isError: item.status === "error",
      lastError: item.status === "error" ? (item.lastError || "") : "",
      title: item.payload?.text || item.payload?.tweetUrl || "",
      tweetUrl: item.payload?.tweetUrl || "",
      config: item.telegramConfigLabel || "",
      createdAt: item.createdAt || 0,
      media: getMediaSummary(item),
      thumbnail: getMediaThumbnail(item)
    });
  }

  function createMediaIcon(item) {
    const tweetUrl = item.payload?.tweetUrl || "";
    const icon = tweetUrl ? document.createElement("a") : document.createElement("div");
    icon.className = "queue-icon";
    if (tweetUrl) {
      icon.href = tweetUrl;
      icon.target = "_blank";
      icon.rel = "noreferrer";
      icon.title = Save2TG.I18n.t("popup_openOriginal");
      icon.setAttribute("aria-label", Save2TG.I18n.t("popup_openOriginal"));
    }

    const thumbnail = getMediaThumbnail(item);
    if (thumbnail) {
      const image = document.createElement("img");
      image.src = thumbnail;
      image.alt = "";
      icon.append(image);
      return icon;
    }

    icon.textContent = getMediaItems(item).some((media) => media.type === "video") ? "VID" : "IMG";
    return icon;
  }


  function renderError(message) {
    lastQueueSignature = "";
    queueList.replaceChildren();
    renderQueuePagination(0, 0);
    const empty = document.createElement("p");
    empty.className = "queue-empty error";
    empty.textContent = message;
    queueList.append(empty);
  }

  /** Get a human-readable label for the current phase. */
  function getPhaseLabel(item) {
    if (item.status === "sending" && item.phase === "uploading") {
      return Save2TG.I18n.t("popup_phaseUpload");
    }

    if (item.status === "sending" && item.phase === "downloading") {
      return Save2TG.I18n.t("popup_phaseDownload");
    }

    const labels = {
      pending: Save2TG.I18n.t("popup_phasePending"),
      sending: Save2TG.I18n.t("popup_phaseSending"),
      error: "",
      sent: ""
    };

    if (Object.prototype.hasOwnProperty.call(labels, item.status)) {
      return labels[item.status];
    }

    return item.status || Save2TG.I18n.t("popup_phasePending");
  }

  function getMediaItems(item) {
    const mediaItems = Array.isArray(item.payload?.mediaItems) ? item.payload.mediaItems : [];
    return mediaItems.length ? mediaItems : (item.payload?.media ? [item.payload.media] : []);
  }

  /** Get a short summary of media items in the payload. */
  function getMediaSummary(item) {
    const mediaItems = getMediaItems(item);
    const photoCount = mediaItems.filter((media) => media.type === "photo").length;
    const videoCount = mediaItems.filter((media) => media.type === "video").length;
    const parts = [];

    if (photoCount) {
      parts.push(Save2TG.I18n.t("popup_mediaPhotos", [photoCount]));
    }

    if (videoCount) {
      parts.push(Save2TG.I18n.t("popup_mediaVideos", [videoCount]));
    }

    return parts.join(" ") || Save2TG.I18n.t("popup_mediaLink");
  }

  /** Get the thumbnail URL for a media item. */
  function getMediaThumbnail(item) {
    const mediaItems = getMediaItems(item);
    const thumbnailItem = mediaItems.find((media) => media.thumbnail) ||
      mediaItems.find((media) => media.type === "photo" && media.url);

    return thumbnailItem?.thumbnail || thumbnailItem?.url || "";
  }

  /** Return whether the queue item has meaningful phase progress to show. */
  function shouldShowQueuePercent(item) {
    return item.status === "sending" && (item.phase === "downloading" || item.phase === "uploading");
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

  /** Get the current progress percentage for a queue item. */
  function getProgress(item) {
    if (item.status === "error") {
      return Math.max(0, Math.min(100, Math.round(item.phaseProgress ?? item.progress ?? 100)));
    }

    return Math.max(0, Math.min(100, Math.round(item.phaseProgress ?? item.progress ?? 0)));
  }

  /** Format a byte count as a human-readable string. */
  function formatBytes(bytes) {
    if (!bytes) {
      return "";
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

  /** Format a timestamp as a human-readable relative or absolute time. */
  function formatTime(timestamp) {
    if (!timestamp) {
      return "";
    }

    const locale = Save2TG.I18n.getLocale() === "zh_CN" ? "zh-CN" : "en";
    return new Intl.DateTimeFormat(locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(timestamp));
  }

})();
