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

exportSettingsButton.addEventListener("click", async () => {
  exportSettingsButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "EXPORT_SETTINGS" });
    if (!response?.ok) {
      throw new Error(response?.error || Save2TG.I18n.t("popup_exportSettingsFailed"));
    }

    downloadSettingsBackup(response.result);
    setSettingsStatus(Save2TG.I18n.t("popup_exportSettingsDone"));
  } catch (error) {
    setSettingsStatus(error.message || String(error), true);
  } finally {
    exportSettingsButton.disabled = false;
  }
});

importSettingsButton.addEventListener("click", () => {
  importSettingsFileInput.value = "";
  importSettingsFileInput.click();
});

importSettingsFileInput.addEventListener("change", async () => {
  const file = importSettingsFileInput.files?.[0];
  if (!file) {
    return;
  }

  importSettingsButton.disabled = true;
  try {
    const backup = JSON.parse(await readTextFile(file));
    const response = await chrome.runtime.sendMessage({ type: "IMPORT_SETTINGS", backup });
    if (!response?.ok) {
      throw new Error(response?.error || Save2TG.I18n.t("popup_importSettingsFailed"));
    }

    configs = response.result?.configs || [];
    applyGeneralSettings(response.result?.settings);
    await applyImportedLanguage(response.result?.uiLanguage);
    renderConfigs();
    editConfig(configs[0] || null);
    currentQueue = await getVisibleQueueFromStorage(response.result?.settings);
    lastQueueSignature = "";
    renderQueue();
    setSettingsStatus(Save2TG.I18n.t("popup_importSettingsDone"));
  } catch (error) {
    setSettingsStatus(error.message || String(error), true);
  } finally {
    importSettingsButton.disabled = false;
    importSettingsFileInput.value = "";
  }
});

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

  const action = button.dataset.action;
  if (action === "send-draft") {
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "SEND_FORWARD_DRAFT" });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_queueOpFailed"));
      }

      currentDraft = null;
      lastQueueSignature = "";
      await loadQueue();
    } catch (error) {
      renderError(error.message || String(error));
    }
    return;
  }

  if (action === "clear-draft") {
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CLEAR_FORWARD_DRAFT" });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("popup_queueOpFailed"));
      }

      currentDraft = null;
      lastQueueSignature = "";
      renderQueue();
    } catch (error) {
      renderError(error.message || String(error));
    }
    return;
  }

  const id = button.dataset.id;
  const type = action === "retry"
    ? "RETRY_FORWARD_QUEUE_ITEM"
    : (action === "cancel" ? "CANCEL_FORWARD_QUEUE_ITEM" : "REMOVE_FORWARD_QUEUE_ITEM");
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
  if (event.target instanceof Element && event.target.closest(".queue-error-tooltip-target")) {
    syncQueueTooltipAnchors();
  }
});
queueList.addEventListener("focusin", (event) => {
  if (event.target instanceof Element && event.target.closest(".queue-error-tooltip-target")) {
    syncQueueTooltipAnchors();
  }
});

Save2TG.I18n.init().then(() => {
  Save2TG.I18n.applyDom();
  setupLanguageSwitcher();
  loadDraft();
  loadQueue();
  loadGeneralSettings();
  loadConfigs();
  setupQueueListWheel();
}).catch(() => {
  loadDraft();
  loadQueue();
  loadGeneralSettings();
  loadConfigs();
  setupQueueListWheel();
});
setInterval(() => {
  loadDraft();
  loadQueue();
}, 2500);

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, DRAFT_KEY)) {
    return;
  }

  currentDraft = normalizeDraftForPopup(changes[DRAFT_KEY].newValue);
  lastQueueSignature = "";
  renderQueue();
});
