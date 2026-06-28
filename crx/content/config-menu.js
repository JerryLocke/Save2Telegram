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
  activeConfigMenuWrapper = wrapper;
  clearHideTimer(wrapper);
  bindMenuHover(menu);

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

  item.addEventListener("click", (event) => handleConfigMenuItemSelect(event, config, button, wrapper));
  item.addEventListener("contextmenu", (event) => handleConfigMenuItemSelect(event, config, button, wrapper));

  return item;
}

async function handleConfigMenuItemSelect(event, config, button, wrapper) {
  event.preventDefault();
  event.stopPropagation();
  hideConfigMenu(wrapper);
  await handleForwardAction(event, button, config.id, { preferConfig: true });
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
  if (wrapper && activeConfigMenuWrapper && activeConfigMenuWrapper !== wrapper) {
    clearHideTimer(wrapper);
    return;
  }

  const menu = document.querySelector(`.${MENU_CLASS}`);
  if (menu) {
    menu.hidden = true;
  }
  if (!wrapper || activeConfigMenuWrapper === wrapper) {
    if (activeConfigMenuWrapper) {
      clearHideTimer(activeConfigMenuWrapper);
    }
    activeConfigMenuWrapper = null;
  }
}

function scheduleHideConfigMenu(wrapper) {
  const menu = document.querySelector(`.${MENU_CLASS}`);
  if (!menu || menu.hidden) {
    return;
  }

  activeConfigMenuWrapper = wrapper;
  clearHideTimer(wrapper);
  wrapper.dataset.tfHideTimer = String(window.setTimeout(() => hideConfigMenuIfInactive(wrapper), 180));
}

function hideConfigMenuIfInactive(wrapper) {
  if (activeConfigMenuWrapper !== wrapper) {
    clearHideTimer(wrapper);
    return;
  }

  const menu = document.querySelector(`.${MENU_CLASS}`);
  if (menu?.matches(":hover") || wrapper?.matches?.(":hover")) {
    return;
  }

  hideConfigMenu(wrapper);
}

function bindMenuHover(menu) {
  if (menu.dataset.tfHoverBound === "true") {
    return;
  }

  menu.dataset.tfHoverBound = "true";
  ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
    menu.addEventListener(type, stopForwardInteractionEvent);
  });
  menu.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    stopForwardInteractionEvent(event);
  });
  menu.addEventListener("mouseenter", () => {
    if (activeConfigMenuWrapper) {
      clearHideTimer(activeConfigMenuWrapper);
    }
  });
  menu.addEventListener("mouseleave", () => {
    if (activeConfigMenuWrapper) {
      scheduleHideConfigMenu(activeConfigMenuWrapper);
    }
  });
}

function clearHideTimer(wrapper) {
  const id = Number(wrapper.dataset.tfHideTimer);
  if (id) {
    window.clearTimeout(id);
    wrapper.dataset.tfHideTimer = "";
  }
}
