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
  dragHandle.innerHTML = ICONS.dragHandle;


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
  deleteBtn.innerHTML = ICONS.close;
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
