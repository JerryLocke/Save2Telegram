/** Add a tweet to the forward queue and start processing. */
async function enqueueForward(payload, sender, configId = "", options = {}) {
  if (!payload?.tweetUrl) {
    throw new Error(__t("bg_noTweetUrl"));
  }
  assertForwardablePayload(payload);
  const config = await getTelegramConfigForSend(configId);
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: "pending",
    payload,
    telegramConfigId: config.id,
    telegramConfigLabel: getTelegramConfigLabel(config),
    telegramChatKey: getTelegramChatKey(config),
    attempts: 0,
    progress: 0,
    phaseProgress: 0,
    phase: "pending",
    bytesLoaded: 0,
    bytesTotal: 0,
    lastError: "",
    debugLog: [createDebugLogEntry("Queued")],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await updateQueue((queue) => {
    if (options.force) {
      return [...queue, item];
    }

    const existing = queue.find((entry) => entry.payload?.tweetUrl === payload.tweetUrl &&
      entry.telegramConfigId === config.id &&
      entry.status !== "error" &&
      entry.status !== "sent");
    return existing ? queue : [...queue, item];
  });
  await touchTelegramConfig(config.id);
  processQueue();
  return item;
}

async function getForwardDraft() {
  const data = await chrome.storage.local.get(DRAFT_KEY);
  return normalizeForwardDraft(data[DRAFT_KEY]);
}

async function getPublicForwardDraft() {
  return serializeForwardDraft(await getForwardDraft());
}

async function writeForwardDraft(draft) {
  const normalized = normalizeForwardDraft(draft);
  if (!normalized) {
    await clearForwardDraft();
    return null;
  }

  await chrome.storage.local.set({ [DRAFT_KEY]: normalized });
  return normalized;
}

async function clearForwardDraft() {
  await chrome.storage.local.remove(DRAFT_KEY);
  return null;
}

async function toggleForwardDraftMedia(payload, configId = "", sourceKey = "", options = {}) {
  const currentDraft = await getForwardDraft();
  const entries = createDraftEntries(payload, sourceKey);
  if (!entries.length) {
    throw new Error(__t("bg_noDraftMedia"));
  }

  const normalizedSourceKey = entries[0].sourceKey;
  const hasSource = currentDraft?.items?.some((item) => item.sourceKey === normalizedSourceKey);
  if (hasSource) {
    const nextItems = currentDraft.items.filter((item) => item.sourceKey !== normalizedSourceKey);
    if (!nextItems.length) {
      await clearForwardDraft();
      return { action: "removed", draft: null };
    }

    const nextDraft = await writeForwardDraft({
      ...currentDraft,
      items: nextItems,
      updatedAt: Date.now()
    });
    return { action: "removed", draft: serializeForwardDraft(nextDraft) };
  }

  const config = await resolveDraftConfig(currentDraft, configId, options);
  const nextItems = mergeDraftEntries(currentDraft?.items || [], entries);
  const now = Date.now();
  const nextDraft = await writeForwardDraft({
    id: currentDraft?.id || createForwardDraftId(),
    version: 1,
    telegramConfigId: config.id,
    telegramConfigLabel: getTelegramConfigLabel(config),
    firstTweet: currentDraft?.firstTweet || entries[0].tweet,
    items: nextItems,
    createdAt: currentDraft?.createdAt || now,
    updatedAt: now
  });

  return { action: "added", draft: serializeForwardDraft(nextDraft) };
}

async function sendForwardDraft(payload, sender, configId = "", sourceKey = "", options = {}) {
  const currentDraft = await getForwardDraft();
  const entries = createDraftEntries(payload, sourceKey);
  let draft = currentDraft;

  if (!draft && entries.length) {
    const config = await resolveDraftConfig(null, configId, options);
    const now = Date.now();
    draft = {
      id: createForwardDraftId(),
      version: 1,
      telegramConfigId: config.id,
      telegramConfigLabel: getTelegramConfigLabel(config),
      firstTweet: entries[0].tweet,
      items: entries,
      createdAt: now,
      updatedAt: now
    };
  } else if (draft && entries.length && !draft.items.some((item) => item.sourceKey === entries[0].sourceKey)) {
    const config = await resolveDraftConfig(draft, configId, options);
    draft = {
      ...draft,
      telegramConfigId: config.id,
      telegramConfigLabel: getTelegramConfigLabel(config),
      items: mergeDraftEntries(draft.items, entries),
      updatedAt: Date.now()
    };
  }

  draft = normalizeForwardDraft(draft);
  if (!draft?.items?.length) {
    throw new Error(__t("bg_emptyDraft"));
  }

  await writeForwardDraft(draft);
  const config = await resolveDraftConfig(draft, configId, options);
  const item = await enqueueForward(buildPayloadFromDraft(draft), sender, config.id, { force: true });
  await clearForwardDraft();
  return { item, draft: null };
}

async function resolveDraftConfig(currentDraft, configId = "", options = {}) {
  const requestedId = String(configId || "").trim();
  const currentId = String(currentDraft?.telegramConfigId || "").trim();
  const selectedId = options?.preferConfig ? (requestedId || currentId) : (currentId || requestedId);
  return getTelegramConfigForSend(selectedId);
}

function createForwardDraftId() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createDraftEntries(payload, sourceKey = "") {
  const tweet = sanitizeDraftTweet(payload);
  const normalizedSourceKey = String(sourceKey || "").trim() || `tweet:${tweet.tweetId || tweet.tweetUrl}`;
  return getPayloadMediaItems(payload)
    .map((media, index) => {
      const sanitizedMedia = sanitizeDraftMedia(media);
      if (!sanitizedMedia) {
        return null;
      }

      return {
        sourceKey: normalizedSourceKey,
        mediaKey: getDraftMediaKey(sanitizedMedia, tweet, index),
        tweet,
        media: sanitizedMedia,
        addedAt: Date.now()
      };
    })
    .filter(Boolean);
}

function mergeDraftEntries(existingItems, entries) {
  const seen = new Set((Array.isArray(existingItems) ? existingItems : []).map((item) => item.mediaKey));
  const next = [...(Array.isArray(existingItems) ? existingItems : [])];
  for (const entry of entries) {
    if (seen.has(entry.mediaKey)) {
      continue;
    }

    seen.add(entry.mediaKey);
    next.push(entry);
  }
  return next;
}

function normalizeForwardDraft(draft) {
  if (!draft || typeof draft !== "object") {
    return null;
  }

  const items = (Array.isArray(draft.items) ? draft.items : [])
    .map(normalizeDraftItem)
    .filter(Boolean);
  if (!items.length) {
    return null;
  }

  return {
    id: String(draft.id || "").trim() || createForwardDraftId(),
    version: 1,
    telegramConfigId: String(draft.telegramConfigId || "").trim(),
    telegramConfigLabel: String(draft.telegramConfigLabel || "").trim(),
    firstTweet: sanitizeDraftTweet(draft.firstTweet || items[0].tweet),
    items,
    createdAt: Number(draft.createdAt || Date.now()),
    updatedAt: Number(draft.updatedAt || Date.now())
  };
}

function normalizeDraftItem(item) {
  const media = sanitizeDraftMedia(item?.media);
  if (!media) {
    return null;
  }

  const tweet = sanitizeDraftTweet(item?.tweet);
  const sourceKey = String(item?.sourceKey || "").trim() || `tweet:${tweet.tweetId || tweet.tweetUrl}`;
  return {
    sourceKey,
    mediaKey: String(item?.mediaKey || "").trim() || getDraftMediaKey(media, tweet, 0),
    tweet,
    media,
    addedAt: Number(item?.addedAt || Date.now())
  };
}

function sanitizeDraftTweet(value) {
  const tweetUrl = String(value?.tweetUrl || "").trim();
  return {
    tweetUrl,
    tweetId: String(value?.tweetId || getTweetIdFromUrl(tweetUrl)).trim(),
    author: String(value?.author || "").trim(),
    text: String(value?.text || "").trim()
  };
}

function sanitizeDraftMedia(media) {
  const type = media?.type === "video" ? "video" : (media?.type === "photo" ? "photo" : "");
  if (!type) {
    return null;
  }

  const candidates = Array.isArray(media?.candidates)
    ? media.candidates.map((url) => String(url || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const url = String(media?.url || candidates[0] || "").trim();
  const thumbnail = String(media?.thumbnail || "").trim();

  if (type === "photo" && !url) {
    return null;
  }
  if (type === "video" && !url && !candidates.length) {
    return null;
  }

  return {
    type,
    url,
    thumbnail,
    sourceId: String(media?.sourceId || "").trim(),
    candidates
  };
}

function getDraftMediaKey(media, tweet, index) {
  const identity = media.type === "video"
    ? (media.sourceId || media.url || media.candidates?.[0] || "")
    : (media.url || media.thumbnail || "");
  return `${media.type}:${identity || `${tweet.tweetId || tweet.tweetUrl}:${index}`}`;
}

function serializeForwardDraft(draft) {
  const normalized = normalizeForwardDraft(draft);
  if (!normalized) {
    return null;
  }

  const mediaItems = normalized.items.map((item) => item.media);
  const counts = getDraftMediaCounts(mediaItems);
  return {
    ...normalized,
    mediaItems,
    count: mediaItems.length,
    photoCount: counts.photoCount,
    videoCount: counts.videoCount
  };
}

function getDraftMediaCounts(mediaItems) {
  return {
    photoCount: mediaItems.filter((media) => media.type === "photo").length,
    videoCount: mediaItems.filter((media) => media.type === "video").length
  };
}

function buildPayloadFromDraft(draft) {
  const mediaItems = draft.items.map((item) => ({
    ...item.media,
    draftMediaKey: item.mediaKey,
    draftSourceKey: item.sourceKey
  }));
  const firstTweet = draft.firstTweet || draft.items[0]?.tweet || {};
  return {
    tweetUrl: firstTweet.tweetUrl || "",
    tweetId: firstTweet.tweetId || getTweetIdFromUrl(firstTweet.tweetUrl || ""),
    author: firstTweet.author || "",
    text: firstTweet.text || "",
    media: mediaItems[0] || null,
    mediaItems,
    originalMediaItems: mediaItems,
    batchDraftId: draft.id,
    sourceTweetUrls: [...new Set(draft.items.map((item) => item.tweet?.tweetUrl).filter(Boolean))]
  };
}

function getTweetIdFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\/status\/(\d+)/)?.[1] || "";
  } catch {
    return "";
  }
}

