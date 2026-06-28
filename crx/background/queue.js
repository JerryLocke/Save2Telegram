/** Reset a failed queue item to pending and retry. */
async function retryQueueItem(id) {
  if (!id) {
    throw new Error("Missing queue item ID.");
  }
  const queue = await getQueue();
  const currentItem = queue.find((item) => item.id === id);
  const retryAfterUntil = Number(currentItem?.retryAfterUntil || 0);
  if (retryAfterUntil > Date.now()) {
    // Fail fast for manual retry during Telegram flood-control cooldown:
    // keep the popup list intact and surface the wait time only via tooltip.
    const message = getFloodControlRetryMessage(retryAfterUntil);
    await markQueueItem(id, {
      lastError: message,
      updatedAt: Date.now()
    });
    return getVisibleQueue();
  }
  await updateQueue((queue) => queue.map((item) => {
    if (item.id !== id) {
      return item;
    }
    return {
      ...item,
      status: "pending",
      phase: "pending",
      progress: 0,
      phaseProgress: 0,
      lastError: "",
      retryAfterUntil: 0,
      retryNotBefore: 0,
      remoteJobId: "",
      updatedAt: Date.now()
    };
  }));
  processQueue();
  return getVisibleQueue();
}
/** Remove a queue item by ID. */
async function removeQueueItem(id) {
  activeQueueAbortControllers.get(id)?.abort();
  await updateQueue((queue) => queue.filter((item) => item.id !== id));
  return getVisibleQueue();
}
/** Cancel a queued forward: remove from queue and notify remote endpoint if applicable. */
async function cancelForwardQueueItem(id) {
  if (!id) throw new Error("Missing queue item ID.");
  activeQueueAbortControllers.get(id)?.abort();
  const queue = await getQueue();
  const item = queue.find(i => i.id === id);
  const remoteJobId = item?.remoteJobId;
  if (remoteJobId) {
    const settings = await getGeneralSettings();
    if (settings.endpointUrl) {
      try {
        await fetch(`${settings.endpointUrl}/api/forward-jobs/${encodeURIComponent(remoteJobId)}`, {
          method: "DELETE",
          headers: getEndpointAuthHeaders(settings)
        });
      } catch (_) { }
    }
  }
  await updateQueue((q) => q.filter((entry) => entry.id !== id));
  return getVisibleQueue();
}
/** Ensure the queue scheduler is running (singleton). */
async function processQueue() {
  if (queueProcessingPromise) {
    return queueProcessingPromise;
  }
  queueProcessingPromise = drainQueue().finally(() => {
    queueProcessingPromise = null;
  });
  return queueProcessingPromise;
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
/** Start pending queue items up to the configured concurrency limit. */
async function drainQueue() {
  if (!activeQueueItemIds.size) {
    await updateQueue((queue) => queue.map((item) => (
      item.status === "sending" ? { ...item, status: "pending", updatedAt: Date.now() } : item
    )));
  }

  while (activeQueueItemIds.size < MAX_CONCURRENT_FORWARD_TASKS) {
    const queue = await failCooldownBlockedPendingQueueItems();
    const item = findNextRunnableQueueItem(queue);
    if (!item) {
      break;
    }
    activeQueueItemIds.add(item.id);
    const chatKey = getQueueItemChatKey(item);
    if (chatKey) {
      activeQueueChatKeys.add(chatKey);
    }
    runQueueItem(item)
      .catch((error) => debugError(item.id, "Queue item runner failed", error))
      .finally(() => {
        activeQueueItemIds.delete(item.id);
        if (chatKey) {
          activeQueueChatKeys.delete(chatKey);
        }
        processQueue();
      });
  }
}
async function failCooldownBlockedPendingQueueItems() {
  const now = Date.now();
  const currentQueue = await getQueue();
  if (!hasCooldownBlockedPendingQueueItems(currentQueue, now)) {
    return currentQueue;
  }
  return updateQueue((queue) => {
    let changed = false;
    const nextQueue = queue.map((item) => {
      if (item.status !== "pending") {
        return item;
      }
      const chatKey = getQueueItemChatKey(item);
      const retryAfterUntil = getQueueChatCooldownUntil(queue, chatKey, now);
      if (!chatKey || retryAfterUntil <= now) {
        return item;
      }
      const message = getFloodControlRetryMessage(retryAfterUntil, now);
      changed = true;
      return {
        ...item,
        status: "error",
        phase: item.phase || "pending",
        lastError: message,
        retryAfterUntil,
        retryNotBefore: 0,
        debugLog: appendDebugLog(item.debugLog, `Failed: ${message}`),
        updatedAt: now
      };
    });
    return changed ? nextQueue : queue;
  });
}
function hasCooldownBlockedPendingQueueItems(queue, now = Date.now()) {
  return queue.some((item) => {
    if (item.status !== "pending") {
      return false;
    }
    const chatKey = getQueueItemChatKey(item);
    return Boolean(chatKey) && getQueueChatCooldownUntil(queue, chatKey, now) > now;
  });
}
function findNextRunnableQueueItem(queue) {
  const now = Date.now();
  return queue.find((entry) => {
    if (entry.status !== "pending" || activeQueueItemIds.has(entry.id)) {
      return false;
    }
    if (Number(entry.retryNotBefore || 0) > now) {
      return false;
    }
    const chatKey = getQueueItemChatKey(entry);
    if (!chatKey) {
      return true;
    }
    return !activeQueueChatKeys.has(chatKey) &&
      getQueueChatCooldownUntil(queue, chatKey, now) <= now;
  });
}
/** Process one queue item. Multiple instances may run in parallel. */
async function runQueueItem(item) {
  const attempt = (item.attempts || 0) + 1;
  const abortController = new AbortController();
  activeQueueAbortControllers.set(item.id, abortController);
  const claimedQueue = await updateQueue((queue) => queue.map((entry) => (
    entry.id === item.id && entry.status === "pending" ? {
      ...entry,
      status: "sending",
      attempts: attempt,
      progress: 0,
      phaseProgress: 0,
      phase: "downloading",
      bytesLoaded: 0,
      bytesTotal: 0,
      lastError: "",
      retryNotBefore: 0,
      debugLog: appendDebugLog(entry.debugLog, `Processing, attempt ${attempt}`),
      updatedAt: Date.now()
    } : entry
  )));
  const claimedItem = claimedQueue.find((entry) => entry.id === item.id);
  if (!claimedItem || claimedItem.status !== "sending" || claimedItem.attempts !== attempt) {
    activeQueueAbortControllers.delete(item.id);
    return;
  }

  try {
    const endpoint = await createForwardEndpoint();
    await endpoint.forward(claimedItem.payload, claimedItem.id, claimedItem.telegramConfigId, {
      signal: abortController.signal
    });
    if (!(await queueHasItem(claimedItem.id))) {
      return;
    }
    debugLog(claimedItem.id, "Queue item sent; marking as sent");
    if ((await getGeneralSettings()).keepCompletedItems) {
      await markQueueItem(claimedItem.id, {
        status: "sent",
        phase: "sent",
        progress: 100,
        phaseProgress: 100,
        lastError: "",
        updatedAt: Date.now()
      });
      await trimCompletedQueueItems((await getGeneralSettings()).maxCompletedItems);
    } else {
      await removeQueueItem(claimedItem.id);
    }
  } catch (error) {
    if (!(await queueHasItem(claimedItem.id))) {
      return;
    }
    debugError(claimedItem.id, "Queue item failed", error);
    const lastError = getQueueErrorMessage(error);
    await appendQueueDebugLog(claimedItem.id, `Failed: ${lastError}`);
    await markQueueItem(claimedItem.id, {
      status: "error",
      lastError,
      retryAfterUntil: getRetryAfterUntil(error),
      updatedAt: Date.now()
    });
  } finally {
    activeQueueAbortControllers.delete(item.id);
  }
}
/** Read the full forward queue from chrome.storage.local. */
async function getQueue() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
}
async function queueHasItem(id) {
  return (await getQueue()).some((item) => item.id === id);
}
async function getVisibleQueue() {
  const [queue, settings] = await Promise.all([getQueue(), getGeneralSettings()]);
  return settings.keepCompletedItems ? queue : queue.filter((item) => item.status !== "sent");
}
/** Atomically update the queue: read, apply updater function, write back. */
async function updateQueue(updater) {
  const operation = queueUpdatePromise.catch(() => { }).then(async () => {
    const queue = await getQueue();
    const nextQueue = updater(queue);
    await chrome.storage.local.set({ [QUEUE_KEY]: nextQueue });
    await updateQueueBadge(nextQueue);
    return nextQueue;
  });
  queueUpdatePromise = operation.catch(() => { });
  return operation;
}
async function clearCompletedQueueItems() {
  return updateQueue((queue) => queue.filter((item) => item.status !== "sent"));
}
/** Trim the number of completed items in the queue to maxCount. */
async function trimCompletedQueueItems(maxCount) {
  const limit = ALLOWED_COMPLETED_RECORD_COUNTS.includes(Number(maxCount))
    ? Number(maxCount)
    : DEFAULT_GENERAL_SETTINGS.maxCompletedItems;
  return updateQueue((queue) => {
    const completed = queue
      .filter((item) => item.status === "sent")
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const keptCompletedIds = new Set(completed.slice(0, limit).map((item) => item.id));
    return queue.filter((item) => item.status !== "sent" || keptCompletedIds.has(item.id));
  });
}
/** Update the extension icon badge with the current queue count. */
async function refreshQueueBadge() {
  await updateQueueBadge(await getQueue());
}
async function updateQueueBadge(queue) {
  const count = queue.filter((item) => item.status !== "sent").length;
  await chrome.action.setBadgeBackgroundColor({ color: "#f04438" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}
/** Apply a partial update to a queue item in storage. */
async function markQueueItem(id, patch) {
  await updateQueue((queue) => queue.map((item) => (
    item.id === id ? { ...item, ...patch } : item
  )));
  if (patch.status === "sent") {
    const settings = await getGeneralSettings();
    if (settings.keepCompletedItems) {
      await trimCompletedQueueItems(settings.maxCompletedItems);
    }
  }
}
/** Append a debug log entry to a queue item. */
async function appendQueueDebugLog(id, message) {
  debugLog(id, message);
  if (!id) {
    return;
  }
  await updateQueue((queue) => queue.map((item) => (
    item.id === id ? { ...item, debugLog: appendDebugLog(item.debugLog, message), updatedAt: Date.now() } : item
  )));
}
function appendDebugLog(log = [], message) {
  return [...(Array.isArray(log) ? log : []), createDebugLogEntry(message)].slice(-12);
}
/** Create a debug log entry object with timestamp. */
function createDebugLogEntry(message) {
  return {
    time: Date.now(),
    message
  };
}
function debugLog(queueItemId, message, data = undefined) {
  const prefix = queueItemId ? `[Save2Telegram][${queueItemId}]` : "[Save2Telegram]";
  if (data === undefined) {
    console.info(prefix, message);
    return;
  }
  console.info(prefix, message, data);
}
function debugError(queueItemId, message, error) {
  const prefix = queueItemId ? `[Save2Telegram][${queueItemId}]` : "[Save2Telegram]";
  console.error(prefix, message, error);
}
