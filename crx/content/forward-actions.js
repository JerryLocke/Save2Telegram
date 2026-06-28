/** Wire click handlers and contextual menu to a forward button. */
function bindButtonInteractions(wrapper, button) {
  if (wrapper.dataset.tfConfigMenuBound === "true") {
    return;
  }

  wrapper.dataset.tfConfigMenuBound = "true";
  ["pointerdown", "mousedown", "mouseup"].forEach((type) => {
    button.addEventListener(type, stopForwardInteractionEvent);
  });
  button.addEventListener("click", (event) => {
    stopForwardInteractionEvent(event);
    handleForwardClick(event, wrapper, button);
  });
  button.addEventListener("contextmenu", (event) => {
    stopForwardInteractionEvent(event);
    handleForwardClick(event, wrapper, button);
  });
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

function stopForwardInteractionEvent(event) {
  event?.stopPropagation?.();
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
  if (isDraftModeEvent(event)) {
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

function isDraftModeEvent(event) {
  return Boolean(event?.ctrlKey || event?.metaKey || event?.button === 2 || event?.type === "contextmenu");
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
