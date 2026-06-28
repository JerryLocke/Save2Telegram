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

async function loadDraft() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_FORWARD_DRAFT" });
    if (!response?.ok) {
      throw new Error(response?.error || Save2TG.I18n.t("popup_readQueueFailed"));
    }

    currentDraft = normalizeDraftForPopup(response.result);
    lastQueueSignature = "";
    renderQueue();
  } catch (_) {
    currentDraft = null;
  }
}

/** Render the forward queue from current visible items. */
function renderQueue() {
  const visibleQueue = getFilteredQueue(currentQueue);
  const visibleDraft = activeQueueFilter === "all" ? currentDraft : null;
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
    draft: getDraftRenderSignature(visibleDraft),
    queue: sortedQueue.map(getQueueRenderSignature)
  });

  if (signature === lastQueueSignature) {
    return;
  }

  lastQueueSignature = signature;

  if (!sortedQueue.length && !visibleDraft) {
    queueList.replaceChildren();
    renderQueuePagination(0, 0);
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = getQueueEmptyText();
    queueList.append(empty);
    return;
  }

  queueList.replaceChildren();

  if (visibleDraft) {
    const draftPage = document.createElement("div");
    draftPage.className = sortedQueue.length ? "queue-draft-page has-queue" : "queue-draft-page";
    draftPage.append(createDraftItem(visibleDraft));
    if (sortedQueue.length) {
      const separator = document.createElement("div");
      separator.className = "queue-draft-separator";
      draftPage.append(separator);
    }
    queueList.append(draftPage);
  }

  if (!sortedQueue.length) {
    renderQueuePagination(0, 0);
    return;
  }

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

function createDraftItem(draft) {
  const article = document.createElement("article");
  article.className = "queue-item draft-item";

  const icon = createDraftIcon(draft);
  const main = document.createElement("div");
  main.className = "queue-main";

  const title = document.createElement("a");
  title.className = "queue-title";
  title.href = draft.firstTweet?.tweetUrl || "#";
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = getDraftTitle(draft);

  const subLine1 = document.createElement("span");
  subLine1.className = "queue-sub-line";
  subLine1.textContent = [
    draft.telegramConfigLabel || "",
    formatTime(draft.updatedAt)
  ].filter(Boolean).join(" · ");

  const subLine2 = document.createElement("span");
  subLine2.className = "queue-sub-line";
  subLine2.textContent = getDraftMediaSummary(draft);
  main.append(title, subLine1, subLine2);

  const sendBtn = createQueueActionButton({
    action: "send-draft",
    className: "queue-draft-send",
    icon: ICONS.send,
    label: Save2TG.I18n.t("popup_sendDraft")
  });
  const clearBtn = createQueueActionButton({
    action: "clear-draft",
    className: "queue-item-delete draft-clear",
    icon: ICONS.close,
    label: Save2TG.I18n.t("popup_clearDraft")
  });

  const status = createQueueStatusElement({
    mode: "text",
    label: Save2TG.I18n.t("popup_draft"),
    actions: [sendBtn, clearBtn]
  });
  article.append(icon, main, status);
  return article;
}

function createDraftIcon(draft) {
  const tweetUrl = draft.firstTweet?.tweetUrl || "";
  const icon = tweetUrl ? document.createElement("a") : document.createElement("div");
  icon.className = "queue-icon draft-icon";
  if (tweetUrl) {
    icon.href = tweetUrl;
    icon.target = "_blank";
    icon.rel = "noreferrer";
    icon.title = Save2TG.I18n.t("popup_openOriginal");
    icon.setAttribute("aria-label", Save2TG.I18n.t("popup_openOriginal"));
  }

  const thumbnails = getDraftThumbnails(draft);
  if (!thumbnails.length) {
    icon.textContent = "IMG";
    return icon;
  }

  const stack = document.createElement("span");
  stack.className = "draft-thumb-stack";
  ["back-left", "back-right", "front"].forEach((position, index) => {
    const thumb = document.createElement("span");
    thumb.className = `draft-thumb ${position}`;
    const image = document.createElement("img");
    image.src = thumbnails[index] || thumbnails[0];
    image.alt = "";
    thumb.append(image);
    stack.append(thumb);
  });
  icon.append(stack);
  return icon;
}

/** Create a DOM element for a single queue item card. */
function createQueueItem(item) {
  const article = document.createElement("article");
  article.dataset.id = item.id;
  article.dataset.structureSignature = getQueueStructureSignature(item);
  article.className = `queue-item status-${item.status || "pending"} phase-${item.phase || "pending"}`;
  syncQueueItemTooltipTarget(article, item);
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

  const status = createQueueStatusElement({
    mode: getQueueStatusMode(item),
    percent: `${getProgress(item)}%`,
    actions: getQueueStatusActions(item)
  });
  renderQueueStatusPhase(status.querySelector(".queue-phase"), item);

  article.append(icon, main, status);
  return article;
}

/** Update an existing queue item DOM element with new data. */
function updateQueueItem(article, item) {
  article.className = `queue-item status-${item.status || "pending"} phase-${item.phase || "pending"}`;
  syncQueueItemTooltipTarget(article, item);
  article.style.setProperty("--progress", `${getProgress(item)}%`);

  const status = article.querySelector(".queue-status");
  if (status) {
    status.className = getQueueStatusClassName(getQueueStatusMode(item), getQueueStatusActionCount(item));
  }

  const phase = article.querySelector(".queue-phase");
  if (phase) {
    renderQueueStatusPhase(phase, item);
  }

  const percent = article.querySelector(".queue-percent");
  if (percent) {
    percent.textContent = `${getProgress(item)}%`;
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

function createQueueStatusElement({ mode, label = "", percent = "", actions = [] }) {
  const status = document.createElement("div");
  status.className = getQueueStatusClassName(mode, actions.length);

  const phase = document.createElement("span");
  phase.className = "queue-phase";
  if (label instanceof Node) {
    phase.append(label);
  } else {
    phase.textContent = label;
  }

  const infoBottom = document.createElement("div");
  infoBottom.className = "queue-info-bottom";

  const percentEl = document.createElement("span");
  percentEl.className = "queue-percent";
  percentEl.textContent = percent;

  infoBottom.append(percentEl, ...actions);
  status.append(phase, infoBottom);
  return status;
}

function getQueueStatusClassName(mode, actionCount = 0) {
  return [
    "queue-status",
    `queue-status--${mode}`,
    actionCount > 0 ? "queue-status--has-actions" : "",
    actionCount > 0 ? `queue-status--actions-${actionCount}` : ""
  ].filter(Boolean).join(" ");
}

// Right-side queue status has two display modes; action-count classes only tune button layout.
function getQueueStatusMode(item) {
  return shouldShowQueuePercent(item) ? "progress" : "text";
}

function renderQueueStatusPhase(phase, item) {
  if (!phase) {
    return;
  }

  phase.replaceChildren();
  if (item.status === "error") {
    phase.append(createQueueErrorTrigger(item));
    return;
  }

  phase.textContent = getPhaseLabel(item);
}

function getQueueStatusActionCount(item) {
  return item.status === "error" ? 2 : 1;
}

function getQueueStatusActions(item) {
  return item.status === "error"
    ? [createQueueRetryButton(item), createQueueRemoveButton(item)]
    : [createQueueRemoveButton(item)];
}

function createQueueRetryButton(item) {
  return createQueueActionButton({
    action: "retry",
    id: item.id,
    className: "retry-inline",
    icon: ICONS.retry,
    label: Save2TG.I18n.t("popup_retry")
  });
}

function createQueueErrorTrigger(item) {
  const errTrigger = document.createElement("span");
  errTrigger.className = "queue-error-trigger";
  errTrigger.setAttribute("data-tooltip", item.lastError || Save2TG.I18n.t("popup_failed"));
  errTrigger.setAttribute("tabindex", "0");
  errTrigger.setAttribute("aria-label", item.lastError || Save2TG.I18n.t("popup_failed"));

  const errIcon = document.createElement("span");
  errIcon.className = "queue-error-icon";
  errIcon.innerHTML = ICONS.error;

  const errLabel = document.createElement("span");
  errLabel.className = "queue-error-label";
  errLabel.textContent = Save2TG.I18n.t("popup_failed");

  errTrigger.append(errIcon, errLabel);
  return errTrigger;
}

function syncQueueItemTooltipTarget(article, item) {
  const errorText = item.status === "error" ? String(item.lastError || "").trim() : "";
  article.classList.toggle("queue-error-tooltip-target", Boolean(errorText));
  if (errorText) {
    article.dataset.tooltip = errorText;
    return;
  }

  delete article.dataset.tooltip;
  article.style.removeProperty("--queue-tooltip-left");
  article.style.removeProperty("--queue-tooltip-top");
  article.style.removeProperty("--queue-tooltip-arrow-left");
  article.style.removeProperty("--queue-tooltip-width");
  article.style.removeProperty("--queue-tooltip-max-width");
}

/** Create a remove/delete button for a queue item. */
function createQueueRemoveButton(item) {
  const button = createQueueActionButton({
    action: "remove",
    id: item.id,
    className: "queue-item-delete",
    icon: ICONS.close,
    label: ""
  });
  updateQueueRemoveButton(button, item);
  return button;
}

function updateQueueRemoveButton(button, item) {
  const isSent = item.status === "sent";
  button.dataset.action = isSent ? "remove" : "cancel";
  button.title = isSent ? Save2TG.I18n.t("popup_delete") : Save2TG.I18n.t("popup_cancel");
  button.setAttribute("aria-label", isSent ? Save2TG.I18n.t("popup_delete") : Save2TG.I18n.t("popup_cancel"));
}

function createQueueActionButton({ action, id = "", className = "", icon, label }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["queue-action-button", className].filter(Boolean).join(" ");
  button.dataset.action = action;
  if (id) {
    button.dataset.id = id;
  }
  button.innerHTML = icon;
  if (label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  return button;
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
 *   - mouseover / focusin on .queue-error-tooltip-target (direct) */
function syncQueueTooltipAnchors() {
  const track = queueList.querySelector(".queue-track");
  if (!track) return;
  const trackRect = track.getBoundingClientRect();
  const popupWidth = document.body.getBoundingClientRect().width || 320;
  const bodyStyles = getComputedStyle(document.body);
  const gutter = parseFloat(bodyStyles.getPropertyValue("--tooltip-popup-gutter")) || 14;
  const arrowSize = parseFloat(bodyStyles.getPropertyValue("--tooltip-arrow-size")) || 6;
  const arrowHalfWidth = parseFloat(bodyStyles.getPropertyValue("--tooltip-arrow-half-width")) || 5;
  const minViewportLeft = gutter;
  const maxViewportRight = popupWidth - gutter;

  document.querySelectorAll(".queue-error-tooltip-target").forEach((target) => {
    const targetStyles = getComputedStyle(target);
    const arrowOverlap = parseFloat(targetStyles.getPropertyValue("--queue-tooltip-arrow-overlap")) || 2;
    const triggerGap = parseFloat(targetStyles.getPropertyValue("--queue-tooltip-trigger-gap")) || 4;
    const marker = target.querySelector(".queue-error-trigger");
    const iconRect = marker?.querySelector(".queue-error-icon")?.getBoundingClientRect();
    const markerRect = iconRect?.width ? iconRect : marker?.getBoundingClientRect();
    const fallbackRect = target.querySelector(".queue-status")?.getBoundingClientRect() || target.getBoundingClientRect();
    const triggerRect = markerRect?.width ? markerRect : fallbackRect;
    if (!triggerRect.width) return;

    // Visual styling stays in CSS pseudo-elements. JS only supplies
    // geometry because .queue-track is transformed for pagination, making
    // position:fixed descendants track-relative instead of viewport-relative.
    const triggerCenterX = triggerRect.left + triggerRect.width / 2;
    const tooltipText = target.getAttribute("data-tooltip") || "";
    const maxWidth = Math.min(276, Math.max(120, maxViewportRight - minViewportLeft));
    const tooltipWidth = measureQueueTooltipWidth(tooltipText, maxWidth);

    const centeredLeft = triggerCenterX - tooltipWidth / 2;
    const viewportLeft = Math.min(
      maxViewportRight - tooltipWidth,
      Math.max(minViewportLeft, centeredLeft)
    );

    // Vertical tuning stays in CSS: triggerGap is the distance from the
    // arrow tip to the error icon; arrowOverlap keeps the bubble connected.
    const tooltipBottom = triggerRect.top - triggerGap - arrowSize + arrowOverlap;
    const left = viewportLeft - trackRect.left;
    const top = tooltipBottom - trackRect.top;
    const arrowLeft = Math.min(
      viewportLeft + tooltipWidth - arrowHalfWidth,
      Math.max(viewportLeft + arrowHalfWidth, triggerCenterX)
    ) - trackRect.left;

    target.style.setProperty("--queue-tooltip-left", `${left.toFixed(1)}px`);
    target.style.setProperty("--queue-tooltip-top", `${top.toFixed(1)}px`);
    target.style.setProperty("--queue-tooltip-arrow-left", `${arrowLeft.toFixed(1)}px`);
    target.style.setProperty("--queue-tooltip-width", `${tooltipWidth.toFixed(1)}px`);
    target.style.setProperty("--queue-tooltip-max-width", `${maxWidth.toFixed(1)}px`);

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
