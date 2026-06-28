/** Send multiple media items as a Telegram album via the endpoint. */
async function forwardTelegramMediaGroup(endpoint, botToken, chatId, payload, mediaItems, caption, queueItemId, signal = null) {
  const chunks = sliceMediaGroupChunks(mediaItems);
  const results = [];
  let itemOffset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunks.length > 1) {
      await appendQueueDebugLog(queueItemId, `Sending media group part ${index + 1}/${chunks.length}`);
    }

    const result = await forwardTelegramMediaGroupChunk(endpoint, botToken, chatId, payload, chunk, index === 0 ? caption : "", queueItemId, signal, {
      itemOffset,
      itemTotal: mediaItems.length
    });
    results.push(result);
    await removeSentQueueMedia(queueItemId, chunk);
    itemOffset += chunk.length;
    await markMediaGroupUploadProgress(queueItemId, itemOffset, mediaItems.length);
  }

  return results;
}

async function forwardTelegramMediaGroupChunk(endpoint, botToken, chatId, payload, albumItems, caption, queueItemId, signal = null, progressScope = {}) {
  const form = new FormData();
  const album = [];
  let attachmentIndex = 0;
  const downloadedFiles = [];
  for (let index = 0; index < albumItems.length; index += 1) {
    const item = albumItems[index];
    if (item.type === "photo" && item.url && !item.url.startsWith("blob:")) {
      await appendQueueDebugLog(queueItemId, "Downloading media group photo");
      const photoFile = await endpoint.downloadPhoto(item, queueItemId, {
        itemIndex: Number(progressScope.itemOffset || 0) + index,
        itemTotal: Number(progressScope.itemTotal || albumItems.length)
      }, signal);
      assertTelegramUploadSize(photoFile.size || photoFile.blob.size || 0, "photo");
      downloadedFiles.push(photoFile);
      await markDownloadedFilesSize(queueItemId, downloadedFiles);
      const attachmentName = `media${attachmentIndex}`;
      attachmentIndex += 1;
      form.set(attachmentName, photoFile.blob, photoFile.filename);
      album.push({ type: "photo", media: `attach://${attachmentName}` });
      continue;
    }
    if (item.type === "video") {
      await appendQueueDebugLog(queueItemId, "Downloading media group video");
      const videoFile = await endpoint.downloadVideo({ ...payload, media: item }, queueItemId, {
        itemIndex: Number(progressScope.itemOffset || 0) + index,
        itemTotal: Number(progressScope.itemTotal || albumItems.length)
      }, signal);
      assertTelegramUploadSize(videoFile.size || videoFile.blob.size || 0, "video");
      downloadedFiles.push(videoFile);
      await markDownloadedFilesSize(queueItemId, downloadedFiles);
      const attachmentName = `media${attachmentIndex}`;
      attachmentIndex += 1;
      form.set(attachmentName, videoFile.blob, videoFile.filename);
      album.push({
        type: "video",
        media: `attach://${attachmentName}`,
        supports_streaming: true
      });
    }
  }
  await markMediaGroupUploadProgress(queueItemId, Number(progressScope.itemOffset || 0), Number(progressScope.itemTotal || albumItems.length), downloadedFiles);
  if (!album.length) {
    await appendQueueDebugLog(queueItemId, "Media group empty, falling back to text message");
    return endpoint.sendMessage(botToken, chatId, caption || payload?.tweetUrl || "", queueItemId, signal);
  }
  if (album.length === 1) {
    await appendQueueDebugLog(queueItemId, "Media group has only one item, sending as single media");
    return sendSingleAlbumItem(endpoint, botToken, chatId, album[0], caption, form, queueItemId, signal);
  }
  // Telegram captions albums on individual items; put the tweet caption on the first item only.
  if (caption) {
    album[0].caption = caption;
    album[0].parse_mode = "HTML";
  }
  form.set("chat_id", chatId);
  form.set("media", JSON.stringify(album));
  await appendQueueDebugLog(queueItemId, `Uploading Telegram media group, ${album.length} item(s)`);
  return endpoint.callMultipart(botToken, "sendMediaGroup", form, queueItemId, signal);
}
/** Send a single media item that was part of a group, using the appropriate API. */
async function sendSingleAlbumItem(endpoint, botToken, chatId, item, caption, form, queueItemId, signal = null) {
  const attachName = item.media.replace("attach://", "");
  const file = form.get(attachName);
  if (item.type === "photo") {
    return endpoint.sendPhotoFile(botToken, chatId, {
      blob: file,
      filename: file?.name || "twitter-photo.jpg"
    }, caption, queueItemId, signal);
  }
  return endpoint.sendVideoFile(botToken, chatId, {
    blob: file,
    filename: file?.name || "twitter-video.mp4"
  }, caption, queueItemId, signal);
}
function sliceMediaGroupChunks(mediaItems) {
  const chunks = [];
  for (let index = 0; index < mediaItems.length; index += TELEGRAM_MEDIA_GROUP_MAX_ITEMS) {
    chunks.push(mediaItems.slice(index, index + TELEGRAM_MEDIA_GROUP_MAX_ITEMS));
  }
  return chunks;
}
async function markMediaGroupUploadProgress(queueItemId, completedItems, totalItems, files = null) {
  if (!queueItemId) {
    return;
  }

  const total = Math.max(1, Number(totalItems || 1));
  const progress = Math.min(100, Math.round((Math.max(0, Number(completedItems || 0)) / total) * 100));
  const size = Array.isArray(files)
    ? files.reduce((sum, file) => sum + (file.size || file.blob?.size || 0), 0)
    : 0;
  await updateQueue((queue) => queue.map((item) => (
    item.id === queueItemId ? {
      ...item,
      progress,
      phaseProgress: progress,
      phase: "uploading",
      bytesLoaded: size || item.bytesLoaded || 0,
      bytesTotal: size || item.bytesTotal || 0,
      updatedAt: Date.now()
    } : item
  )));
}
async function removeSentQueueMedia(queueItemId, sentMediaItems) {
  const mediaKeys = (Array.isArray(sentMediaItems) ? sentMediaItems : [])
    .map((media) => String(media?.draftMediaKey || "").trim())
    .filter(Boolean);
  if (!queueItemId || !mediaKeys.length) {
    return;
  }

  const sentKeys = new Set(mediaKeys);
  // Drafts are cleared as soon as they enter the queue, so retry state lives
  // on the queue item itself and shrinks after each successful Telegram send.
  await updateQueue((queue) => queue.map((item) => {
    if (item.id !== queueItemId || !item.payload?.batchDraftId) {
      return item;
    }

    const mediaItems = getPayloadMediaItems(item.payload);
    const nextMediaItems = mediaItems.filter((media) => !sentKeys.has(String(media?.draftMediaKey || "").trim()));
    return {
      ...item,
      payload: {
        ...item.payload,
        media: nextMediaItems[0] || null,
        mediaItems: nextMediaItems
      },
      updatedAt: Date.now()
    };
  }));
}
async function removeSentDraftMediaKeysByQueueItem(queueItemId, mediaKeys) {
  const keys = (Array.isArray(mediaKeys) ? mediaKeys : [])
    .map((key) => String(key || "").trim())
    .filter(Boolean);
  if (!queueItemId || !keys.length) {
    return;
  }

  await removeSentQueueMedia(queueItemId, keys.map((key) => ({ draftMediaKey: key })));
}
/** Update queue item state for the upload phase. */
async function markTelegramUploadProgress(queueItemId, videoFile = null) {
  if (!queueItemId) {
    return;
  }
  const size = Array.isArray(videoFile)
    ? videoFile.reduce((total, file) => total + (file.size || file.blob?.size || 0), 0)
    : (videoFile ? (videoFile.size || videoFile.blob?.size || 0) : 0);
  await updateQueue((queue) => queue.map((item) => (
    item.id === queueItemId ? {
      ...item,
      progress: 0,
      phaseProgress: 0,
      phase: "uploading",
      bytesLoaded: size || item.bytesLoaded || 0,
      bytesTotal: size || item.bytesTotal || 0,
      debugLog: size ? appendDebugLog(item.debugLog, `Downloaded, file size ${formatDebugBytes(size)}`) : item.debugLog,
      updatedAt: Date.now()
    } : item
  )));
}
/** Record the total downloaded size for a set of files. */
async function markDownloadedFilesSize(queueItemId, files) {
  const size = files.reduce((total, file) => total + (file.size || file.blob.size || 0), 0);
  await markQueueItem(queueItemId, {
    bytesLoaded: size,
    bytesTotal: size,
    updatedAt: Date.now()
  });
}
/** Download a Twitter video from available candidates, trying each in order. */
async function downloadTwitterVideo(payload, queueItemId, progressScope = {}, signal = null) {
  throwIfAborted(signal);
  const progress = createDownloadProgressReporter(queueItemId, progressScope);
  const media = payload?.media || {};
  const candidates = normalizeVideoCandidates(media);
  if (!candidates.length) {
    throw new Error(__t("bg_noDownloadableVideo"));
  }
  const errors = [];
  for (const candidate of candidates) {
    try {
      throwIfAborted(signal);
      if (candidate.includes(".m3u8")) {
        return downloadM3u8Video(candidate, queueItemId, progressScope, signal);
      }
      const blob = await fetchVideoBlob(candidate, progress, signal);
      return {
        blob,
        size: blob.size,
        filename: "twitter-video.mp4"
      };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw createCancelledError();
      }
      errors.push(error.message || String(error));
    }
  }
  throw new Error(__t("bg_videoDownloadFailed", [errors[0] || "No available video source"]));
}
async function downloadTwitterPhoto(media, queueItemId, progressScope = {}, signal = null) {
  throwIfAborted(signal);
  const url = typeof media?.url === "string" ? media.url : "";
  if (!url || url.startsWith("blob:")) {
    throw new Error(__t("bg_noDraftMedia"));
  }

  const blob = await fetchBlobWithProgress(url, createDownloadProgressReporter(queueItemId, progressScope), signal, "image/jpeg");
  return {
    blob,
    size: blob.size,
    filename: getPhotoFilename(url, blob.type)
  };
}
function createDownloadProgressReporter(queueItemId, progressScope = {}) {
  if (!queueItemId) {
    return null;
  }
  const itemIndex = Math.max(0, Number(progressScope.itemIndex || 0));
  const itemTotal = Math.max(1, Number(progressScope.itemTotal || 1));
  const partIndex = Math.max(0, Number(progressScope.partIndex || 0));
  const partTotal = Math.max(1, Number(progressScope.partTotal || 1));
  let lastUpdateAt = 0;
  return async ({ loaded, total }) => {
    const now = Date.now();
    // Each media item gets an equal slice of the download phase.
    const partRatio = total ? loaded / total : 0;
    const itemRatio = (partIndex + partRatio) / partTotal;
    const progress = total
      ? Math.min(100, Math.round(((itemIndex + itemRatio) / itemTotal) * 100))
      : Math.min(100, Math.round((itemIndex / itemTotal) * 100) + 5);
    if (now - lastUpdateAt < 600 && progress < 100) {
      return;
    }
    lastUpdateAt = now;
    await markQueueItem(queueItemId, {
      phase: "downloading",
      progress,
      phaseProgress: progress,
      bytesLoaded: partTotal > 1 ? 0 : loaded,
      bytesTotal: partTotal > 1 ? 0 : (total || 0),
      updatedAt: now
    });
  };
}
/** Extract and deduplicate video source URLs from media metadata. */
function normalizeVideoCandidates(media) {
  const urls = [
    media.url,
    ...(Array.isArray(media.candidates) ? media.candidates : [])
  ].filter((url) => typeof url === "string" && url && !url.startsWith("blob:"));
  return [...new Set(urls)]
    .filter(isDownloadableTwitterVideoUrl)
    .sort(rankVideoUrlType);
}
/** Check if a URL is a downloadable twitter video resource. */
function isDownloadableTwitterVideoUrl(url) {
  if (typeof url !== "string" || !VIDEO_HOST_PATTERN.test(url)) {
    return false;
  }
  if (url.includes(".m3u8")) {
    return true;
  }
  return url.includes(".mp4") && !isFragmentedMp4InitUrl(url);
}
function isFragmentedMp4InitUrl(url) {
  return /\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url);
}
function rankVideoUrlType(a, b) {
  const aIsMp4 = a.includes(".mp4") ? 1 : 0;
  const bIsMp4 = b.includes(".mp4") ? 1 : 0;
  return bIsMp4 - aIsMp4;
}
function assertTelegramUploadSize(size, mediaType) {
  const limit = mediaType === "photo" ? TELEGRAM_PHOTO_UPLOAD_MAX_BYTES : TELEGRAM_FILE_UPLOAD_MAX_BYTES;
  if (Number(size || 0) > limit) {
    throw new Error(mediaType === "photo" ? __t("bg_photoTooLarge") : __t("bg_videoTooLarge"));
  }
}
function getPhotoFilename(url, contentType = "") {
  const extension = contentType.includes("png") ? "png" : (contentType.includes("webp") ? "webp" : "jpg");
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop() || "";
    const base = name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "twitter-photo";
    return `${base}.${extension}`;
  } catch {
    return `twitter-photo.${extension}`;
  }
}
async function fetchVideoBlob(url, onProgress = null, signal = null) {
  return fetchBlobWithProgress(url, onProgress, signal, "video/mp4");
}
async function fetchBlobWithProgress(url, onProgress = null, signal = null, fallbackType = "application/octet-stream") {
  const response = await fetch(url, {
    credentials: "include",
    signal
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const total = Number(response.headers.get("Content-Length") || 0);
  if (!response.body || !onProgress) {
    const blob = await response.blob();
    if (onProgress) {
      await onProgress({ loaded: blob.size, total: total || blob.size });
    }
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    await onProgress({ loaded, total });
  }
  await onProgress({ loaded, total: total || loaded });
  return new Blob(chunks, { type: response.headers.get("Content-Type") || fallbackType });
}
/** Download an HLS video stream by concatenating all segments. */
async function downloadM3u8Video(url, queueItemId = "", progressScope = {}, signal = null) {
  throwIfAborted(signal);
  const playlist = await fetchText(url, signal);
  const audioPlaylistUrl = resolveBestAudioPlaylistUrl(url, playlist);
  const mediaPlaylistUrl = resolveBestPlaylistUrl(url, playlist);
  if (audioPlaylistUrl && mediaPlaylistUrl !== url) {
    throw new Error(__t("bg_hlsSeparateStreams"));
  }
  const mediaPlaylist = mediaPlaylistUrl === url ? playlist : await fetchText(mediaPlaylistUrl, signal);
  const parts = parseMediaPlaylist(mediaPlaylistUrl, mediaPlaylist);
  if (!parts.length) {
    throw new Error(__t("bg_noHlsSegments"));
  }
  const blobs = [];
  for (let index = 0; index < parts.length; index += 1) {
    throwIfAborted(signal);
    const progress = createDownloadProgressReporter(queueItemId, {
      ...progressScope,
      partIndex: index,
      partTotal: parts.length
    });
    blobs.push(await fetchVideoBlob(parts[index], progress, signal));
  }
  const isFragmentedMp4 = parts.some((partUrl) => /\.(m4s|cmfv|mp4)(\?|$)/.test(partUrl));
  return {
    blob: new Blob(blobs, { type: isFragmentedMp4 ? "video/mp4" : "video/mp2t" }),
    filename: isFragmentedMp4 ? "twitter-video.mp4" : "twitter-video.ts"
  };
}
/** Find the best audio-only playlist from an HLS master playlist. */
function resolveBestAudioPlaylistUrl(baseUrl, playlist) {
  const mediaLines = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(line));
  const audioVariants = mediaLines
    .map((line) => ({
      url: line.match(/URI="([^"]+)"/)?.[1] || "",
      bitrate: Number(line.match(/GROUP-ID="audio-(\d+)"/)?.[1] || 0)
    }))
    .filter((variant) => variant.url);
  if (!audioVariants.length) {
    return "";
  }
  audioVariants.sort((a, b) => b.bitrate - a.bitrate);
  return new URL(audioVariants[0].url, baseUrl).toString();
}
async function fetchText(url, signal = null) {
  const response = await fetch(url, {
    credentials: "include",
    signal
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}
/** Find the highest-resolution video playlist from an HLS master playlist. */
function resolveBestPlaylistUrl(baseUrl, playlist) {
  const lines = playlist.split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }
    const nextUrl = findNextPlaylistUrl(lines, index + 1);
    if (!nextUrl) {
      continue;
    }
    variants.push({
      url: new URL(nextUrl, baseUrl).toString(),
      bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0),
      pixels: getResolutionPixels(line)
    });
  }
  if (!variants.length) {
    return baseUrl;
  }
  variants.sort((a, b) => (b.pixels - a.pixels) || (b.bandwidth - a.bandwidth));
  return variants[0].url;
}
function findNextPlaylistUrl(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line && !line.startsWith("#")) {
      return line;
    }
  }
  return "";
}
function getResolutionPixels(line) {
  const match = line.match(/RESOLUTION=(\d+)x(\d+)/);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}
/** Parse an HLS media playlist into absolute segment URLs. */
function parseMediaPlaylist(baseUrl, playlist) {
  const lines = playlist.split(/\r?\n/);
  const parts = [];
  for (const line of lines) {
    const mapUri = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/)?.[1];
    if (mapUri) {
      parts.push(new URL(mapUri, baseUrl).toString());
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      parts.push(new URL(trimmed, baseUrl).toString());
    }
  }
  return parts;
}
function buildCaption(payload) {
  const author = escapeTelegramHtml(payload?.author || "");
  const text = String(payload?.text || "").trim();
  const tweetUrl = payload?.tweetUrl || "";
  const body = formatTweetTextForTelegram(text);
  const parts = [];
  if (author) {
    parts.push(author);
  }
  if (body) {
    parts.push(body);
  }
  if (tweetUrl) {
    parts.push(escapeTelegramHtml(tweetUrl));
  }
  return truncateTelegramCaption(parts.join("\n\n"));
}
function truncateTelegramCaption(caption) {
  if (caption.length <= 1024) {
    return caption;
  }
  const quoteStart = caption.search(/<blockquote(?:\s+expandable)?>/);
  const quoteEnd = caption.lastIndexOf("</blockquote>");
  if (quoteStart >= 0 && quoteEnd > quoteStart) {
    const openTagEnd = caption.indexOf(">", quoteStart) + 1;
    const prefix = caption.slice(0, openTagEnd);
    const quote = caption.slice(openTagEnd, quoteEnd);
    const suffix = caption.slice(quoteEnd);
    const maxQuoteLength = 1024 - prefix.length - suffix.length - 3;
    if (maxQuoteLength > 0) {
      return `${prefix}${truncateEscapedHtml(quote, maxQuoteLength)}...${suffix}`;
    }
  }
  return `${truncateEscapedHtml(caption, 1021)}...`;
}
function formatTweetTextForTelegram(text) {
  if (!text) {
    return "";
  }
  // Long tweets read better as Telegram blockquotes; a short first paragraph stays as the title.
  const paragraphs = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const isLongTweet = text.length > 280;
  const hasShortTitle = isLongTweet && paragraphs.length > 1 && paragraphs[0].length <= 80;
  if (!isLongTweet) {
    return escapeTelegramHtml(text);
  }
  if (hasShortTitle) {
    return [
      escapeTelegramHtml(paragraphs[0]),
      wrapTelegramQuote(paragraphs.slice(1).join("\n"))
    ].join("\n\n");
  }
  return wrapTelegramQuote(text);
}
function wrapTelegramQuote(text) {
  return `<blockquote expandable>${escapeTelegramHtml(text)}</blockquote>`;
}
function escapeTelegramHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function truncateEscapedHtml(value, maxLength) {
  const sliced = value.slice(0, maxLength).trimEnd();
  return sliced.replace(/&[^;\s]*$/, "");
}
