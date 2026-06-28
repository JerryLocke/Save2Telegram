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

function downloadSettingsBackup(backup) {
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `save2telegram-settings-${date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(Save2TG.I18n.t("popup_importSettingsFailed")));
    reader.readAsText(file);
  });
}

async function applyImportedLanguage(language) {
  const normalized = ["auto", "en", "zh_CN"].includes(language) ? language : "auto";
  if (languageSelect) {
    languageSelect.value = normalized;
  }
  Save2TG.I18n.reset();
  await Save2TG.I18n.init();
  Save2TG.I18n.applyDom();
  refreshLocalizedDynamicContent();
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
