function normalizeDraftForPopup(draft) {
  if (!draft || typeof draft !== "object") {
    return null;
  }

  const items = Array.isArray(draft.items) ? draft.items.filter((item) => item?.media) : [];
  if (!items.length) {
    return null;
  }

  const mediaItems = Array.isArray(draft.mediaItems)
    ? draft.mediaItems
    : items.map((item) => item.media).filter(Boolean);
  return {
    ...draft,
    items,
    mediaItems,
    count: Number(draft.count || mediaItems.length)
  };
}

function getDraftRenderSignature(draft) {
  if (!draft) {
    return null;
  }

  return {
    id: draft.id || "",
    updatedAt: draft.updatedAt || 0,
    title: getDraftTitle(draft),
    config: draft.telegramConfigLabel || "",
    media: getDraftMediaSummary(draft),
    thumbnails: getDraftThumbnails(draft)
  };
}

function getDraftTitle(draft) {
  return draft?.firstTweet?.text ||
    draft?.firstTweet?.tweetUrl ||
    draft?.items?.[0]?.tweet?.text ||
    draft?.items?.[0]?.tweet?.tweetUrl ||
    Save2TG.I18n.t("popup_draftBox");
}

function getDraftMediaItems(draft) {
  const mediaItems = Array.isArray(draft?.mediaItems) ? draft.mediaItems : [];
  if (mediaItems.length) {
    return mediaItems;
  }

  return (Array.isArray(draft?.items) ? draft.items : [])
    .map((item) => item.media)
    .filter(Boolean);
}

function getDraftMediaSummary(draft) {
  return summarizeMediaItems(getDraftMediaItems(draft));
}

function getDraftThumbnails(draft) {
  return getDraftMediaItems(draft)
    .map((media) => media.thumbnail || (media.type === "photo" ? media.url : ""))
    .filter(Boolean)
    .slice(0, 3);
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
    thumbnails: getQueueThumbnails(item)
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
    thumbnails: getQueueThumbnails(item)
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

  const thumbnails = getQueueThumbnails(item);
  if (isTelegramAlbum(item) && thumbnails.length) {
    icon.classList.add("draft-icon");
    icon.append(createThumbnailStack(thumbnails));
    return icon;
  }

  const thumbnail = thumbnails[0];
  if (thumbnail) {
    const image = document.createElement("img");
    image.src = thumbnail;
    image.alt = "";
    icon.append(image);
    return icon;
  }

  icon.textContent = item.payload?.source === 'telegram' ? 'TG' : getMediaItems(item).some((media) => media.type === "video") ? "VID" : "IMG";
  return icon;
}

/** Shared album preview used by X drafts and Telegram queue records. */
function createThumbnailStack(thumbnails) {
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
  return stack;
}

function getTelegramMediaCount(item) {
  return item.payload?.telegramSource?.messageIds?.length || getMediaItems(item).length;
}

function isTelegramAlbum(item) {
  return item.payload?.source === "telegram" && getTelegramMediaCount(item) > 1;
}

function getQueueThumbnails(item) {
  if (isTelegramAlbum(item)) {
    return getMediaItems(item).map(media => media.thumbnail).filter(Boolean).slice(0, 3);
  }
  const thumbnail = getMediaThumbnail(item);
  return thumbnail ? [thumbnail] : [];
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
  if (item.status === 'sending' && item.phase === 'forwarding') {
    return Save2TG.I18n.t('popup_phaseForward');
  }
  if (item.status === "sending" && item.phase === "uploading") {
    return Save2TG.I18n.t("popup_phaseUpload");
  }

  if (item.status === "sending" && item.phase === "downloading") {
    return Save2TG.I18n.t("popup_phaseDownload");
  }

  const labels = {
    pending: Save2TG.I18n.t("popup_phasePending"),
    sending: Save2TG.I18n.t("popup_phaseSending"),
    error: Save2TG.I18n.t("popup_failed"),
    sent: Save2TG.I18n.t("popup_done")
  };

  if (Object.prototype.hasOwnProperty.call(labels, item.status)) {
    return labels[item.status];
  }

  return item.status || Save2TG.I18n.t("popup_phasePending");
}

function getMediaItems(item) {
  const mediaItems = Array.isArray(item.payload?.mediaItems) ? item.payload.mediaItems : [];
  if (mediaItems.length) {
    return mediaItems;
  }

  const originalItems = Array.isArray(item.payload?.originalMediaItems) ? item.payload.originalMediaItems : [];
  if (item.status === "sent" && originalItems.length) {
    return originalItems;
  }

  return item.payload?.media ? [item.payload.media] : [];
}

/** Get a short summary of media items in the payload. */
function getMediaSummary(item) {
  return summarizeMediaItems(getMediaItems(item));
}

/** Keep media counts and ordering identical across drafts and queue sources. */
function summarizeMediaItems(mediaItems) {
  const parts = [];
  for (const [type, key] of [
    ['video', 'popup_mediaVideos'], ['photo', 'popup_mediaPhotos'],
    ['audio', 'popup_mediaAudio'], ['document', 'popup_mediaFiles'], ['sticker', 'popup_mediaStickers']
  ]) {
    const count = mediaItems.filter(media => media.type === type).length;
    if (count) parts.push(Save2TG.I18n.t(key, [count]));
  }
  // Old records can lack media types; don't invent a photo/video count for them.
  return parts.join(" ") || Save2TG.I18n.t(mediaItems.length ? "popup_media" : "popup_mediaLink");
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
