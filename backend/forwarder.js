import { AppError, Err } from "./errors.js";
import { buildCaption } from "./caption.js";
import { TELEGRAM_API_BASE } from "./config.js";
import { checkCancelled, updateJob } from "./jobs.js";
import { downloadTwitterVideo } from "./twitter-video.js";
import { callTelegramMultipart, createMultipartForm, sendTelegramMessage, sendTelegramPhotoFile, sendTelegramVideoFile, validateTelegramChat } from "./telegram.js";
import { cleanupUploadFile, cleanupUploadFiles, createTempUploadFile, createUploadFileWriteStream, finishWriteStream, getUploadFileSize, writeChunk } from "./upload-file.js";

const TELEGRAM_MEDIA_GROUP_MAX_ITEMS = 10;
const TELEGRAM_PHOTO_UPLOAD_MAX_BYTES = parseByteLimit(process.env.TELEGRAM_PHOTO_UPLOAD_MAX_BYTES, 10 * 1024 * 1024);
const TELEGRAM_CLOUD_FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_LOCAL_FILE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// The public Bot API rejects larger uploads, while a local/self-hosted Bot API
// can accept much larger files. Env vars can still tighten or relax this.
const TELEGRAM_FILE_UPLOAD_MAX_BYTES = parseByteLimit(
  process.env.TELEGRAM_FILE_UPLOAD_MAX_BYTES || process.env.TELEGRAM_UPLOAD_MAX_BYTES,
  isTelegramCloudApi() ? TELEGRAM_CLOUD_FILE_UPLOAD_MAX_BYTES : TELEGRAM_LOCAL_FILE_UPLOAD_MAX_BYTES
);

/** Base class for Telegram forwarding operations. */
class ForwardEndpoint {
  async forward() {
    throw new AppError(Err.UNKNOWN, "ForwardEndpoint.forward must be implemented.");
  }
}


/** Node.js implementation of ForwardEndpoint using the Telegram Bot API directly. */
class NodeForwardEndpoint extends ForwardEndpoint {
  async forward(payload, telegram, job = null) {
    const botToken = String(telegram?.botToken || "").trim();
    const chatId = String(telegram?.chatId || "").trim();
    const signal = job?.abortController?.signal;
    if (!botToken || !chatId) {
      throw new AppError(Err.MISSING_CONFIG, "Missing Telegram Bot Token or Channel ID.");
    }

    updateJob(job, { phase: "validating", phaseProgress: 0, progress: 0 });
    await validateTelegramChat(botToken, chatId, signal);
    const tweetUrl = payload?.tweetUrl || "";
    const caption = payload.caption || buildCaption(payload);
    const mediaItems = payload.mediaItems || getPayloadMediaItems(payload);

    if (!mediaItems.length) {
      updateJob(job, { phase: "uploading", phaseProgress: 0, progress: 0 });
      return sendTelegramMessage(botToken, chatId, caption || tweetUrl, signal);
    }

    if (mediaItems.length > 1) {
      return forwardTelegramMediaGroup(botToken, chatId, payload, mediaItems, caption, job);
    }

    const media = mediaItems[0];
    if (media?.type === "video") {
      let videoFile = null;
      try {
        videoFile = await downloadTwitterVideo({ ...payload, media }, job, {}, {
          maxBytes: getTelegramUploadMaxBytes("video")
        });
        const videoSize = getUploadFileSize(videoFile);
        assertTelegramUploadSize(videoSize, "video");
        updateJob(job, {
          phase: "uploading",
          phaseProgress: 0,
          progress: 0,
          bytesLoaded: videoSize,
          bytesTotal: videoSize
        });
        const result = await sendTelegramVideoFile(botToken, chatId, videoFile, caption, {
          signal,
          onUploadProgress: createJobUploadProgress(job)
        });
        markSentDraftMedia(job, [media]);
        return result;
      } finally {
        await cleanupUploadFile(videoFile);
      }
    }

    if (!media?.url || media.url.startsWith("blob:")) {
      updateJob(job, { phase: "uploading", phaseProgress: 0, progress: 0 });
      return sendTelegramMessage(botToken, chatId, caption || tweetUrl, signal);
    }

    let photoFile = null;
    try {
      photoFile = await downloadTwitterPhoto(media, job, { itemIndex: 0, itemTotal: 1 });
      const photoSize = getUploadFileSize(photoFile);
      assertTelegramUploadSize(photoSize, "photo");
      updateJob(job, {
        phase: "uploading",
        phaseProgress: 0,
        progress: 0,
        bytesLoaded: photoSize,
        bytesTotal: photoSize
      });
      const result = await sendTelegramPhotoFile(botToken, chatId, photoFile, caption, {
        signal,
        onUploadProgress: createJobUploadProgress(job)
      });
      markSentDraftMedia(job, [media]);
      return result;
    } finally {
      await cleanupUploadFile(photoFile);
    }
  }
}

/** Extract and filter media items from a tweet payload (photo and video only). */
export function getPayloadMediaItems(payload) {
  const mediaItems = Array.isArray(payload?.mediaItems) ? payload.mediaItems : [];
  const items = mediaItems.length ? mediaItems : (payload?.media ? [payload.media] : []);
  return items.filter((item) => item?.type === "photo" || item?.type === "video");
}

/** Send multiple media items, splitting into Telegram-sized media groups. */
async function forwardTelegramMediaGroup(botToken, chatId, payload, mediaItems, caption, job = null) {
  const chunks = sliceMediaGroupChunks(mediaItems);
  const results = [];
  let itemOffset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = await forwardTelegramMediaGroupChunk(botToken, chatId, payload, chunk, index === 0 ? caption : "", job, {
      itemOffset,
      itemTotal: mediaItems.length
    });
    results.push(result);
    markSentDraftMedia(job, chunk);
    itemOffset += chunk.length;
    updateJob(job, {
      phase: "uploading",
      progress: Math.min(100, Math.round((itemOffset / mediaItems.length) * 100)),
      phaseProgress: Math.min(100, Math.round((itemOffset / mediaItems.length) * 100))
    });
  }

  return results;
}

async function forwardTelegramMediaGroupChunk(botToken, chatId, payload, albumItems, caption, job = null, progressScope = {}) {
  const form = createMultipartForm();
  const album = [];
  let attachmentIndex = 0;
  // Media group parts must stay on disk until Telegram has consumed the full multipart request.
  const downloadedFiles = [];

  try {
    for (let index = 0; index < albumItems.length; index += 1) {
      const item = albumItems[index];
      if (item.type === "photo" && item.url && !item.url.startsWith("blob:")) {
        const photoFile = await downloadTwitterPhoto(item, job, {
          itemIndex: Number(progressScope.itemOffset || 0) + index,
          itemTotal: Number(progressScope.itemTotal || albumItems.length)
        });
        downloadedFiles.push(photoFile);
        assertTelegramUploadSize(getUploadFileSize(photoFile), "photo");
        markDownloadedFilesSize(job, downloadedFiles);
        const attachmentName = `media${attachmentIndex}`;
        attachmentIndex += 1;
        form.set(attachmentName, photoFile, photoFile.filename);
        album.push({ type: "photo", media: `attach://${attachmentName}` });
        continue;
      }

      if (item.type === "video") {
        const videoFile = await downloadTwitterVideo({ ...payload, media: item }, job, {
          itemIndex: Number(progressScope.itemOffset || 0) + index,
          itemTotal: Number(progressScope.itemTotal || albumItems.length)
        }, {
          maxBytes: getTelegramUploadMaxBytes("video")
        });
        downloadedFiles.push(videoFile);
        assertTelegramUploadSize(getUploadFileSize(videoFile), "video");
        markDownloadedFilesSize(job, downloadedFiles);
        const attachmentName = `media${attachmentIndex}`;
        attachmentIndex += 1;
        form.set(attachmentName, videoFile, videoFile.filename);
        album.push({ type: "video", media: `attach://${attachmentName}`, supports_streaming: true });
      }
    }

    if (!album.length) {
      checkCancelled(job);
      return await sendTelegramMessage(botToken, chatId, caption || payload?.tweetUrl || "", job?.abortController?.signal);
    }

    if (album.length === 1) {
      return await sendSingleAlbumItem(botToken, chatId, album[0], caption, form, job, progressScope);
    }

    if (caption) {
      album[0].caption = caption;
      album[0].parse_mode = "HTML";
    }

    form.set("chat_id", chatId);
    form.set("media", JSON.stringify(album));
    const uploadStart = Math.min(100, Math.round((Number(progressScope.itemOffset || 0) / Math.max(1, Number(progressScope.itemTotal || albumItems.length))) * 100));
    updateJob(job, { phase: "uploading", phaseProgress: uploadStart, progress: uploadStart });
    checkCancelled(job);
    return await callTelegramMultipart(botToken, "sendMediaGroup", form, {
      signal: job?.abortController?.signal,
      onUploadProgress: createJobUploadProgress(job, {
        itemOffset: Number(progressScope.itemOffset || 0),
        itemCount: albumItems.length,
        itemTotal: Number(progressScope.itemTotal || albumItems.length)
      })
    });
  } finally {
    await cleanupUploadFiles(downloadedFiles);
  }
}

/** Send a single media item from an album, falling back to single-media API. */
async function sendSingleAlbumItem(botToken, chatId, item, caption, form, job = null, progressScope = {}) {
  const uploadProgressScope = {
    itemOffset: Number(progressScope.itemOffset || 0),
    itemCount: 1,
    itemTotal: Number(progressScope.itemTotal || 1)
  };
  const attachName = item.media.replace("attach://", "");
  const file = form.get(attachName);
  if (item.type === "photo") {
    return sendTelegramPhotoFile(botToken, chatId, file, caption, {
      signal: job?.abortController?.signal,
      onUploadProgress: createJobUploadProgress(job, uploadProgressScope)
    });
  }

  return sendTelegramVideoFile(botToken, chatId, file, caption, {
    signal: job?.abortController?.signal,
    onUploadProgress: createJobUploadProgress(job, uploadProgressScope)
  });
}

function sliceMediaGroupChunks(mediaItems) {
  const chunks = [];
  for (let index = 0; index < mediaItems.length; index += TELEGRAM_MEDIA_GROUP_MAX_ITEMS) {
    chunks.push(mediaItems.slice(index, index + TELEGRAM_MEDIA_GROUP_MAX_ITEMS));
  }
  return chunks;
}

function markSentDraftMedia(job, mediaItems) {
  if (!job) return;
  const keys = mediaItems
    .map((item) => String(item?.draftMediaKey || "").trim())
    .filter(Boolean);
  if (!keys.length) return;

  updateJob(job, {
    sentDraftMediaKeys: [...new Set([...(Array.isArray(job.sentDraftMediaKeys) ? job.sentDraftMediaKeys : []), ...keys])]
  });
}

async function downloadTwitterPhoto(media, job = null, progressScope = {}) {
  checkCancelled(job);
  const url = typeof media?.url === "string" ? media.url : "";
  if (!url || url.startsWith("blob:")) {
    throw new AppError(Err.NO_MEDIA_SOURCE, "No downloadable photo URL found.");
  }

  return fetchUploadFileWithProgress(url, createJobDownloadProgress(job, progressScope), job?.abortController?.signal, {
    fallbackType: "image/jpeg",
    maxBytes: getTelegramUploadMaxBytes("photo"),
    prefix: "twitter-photo",
    resolveFilename: (contentType) => getPhotoFilename(url, contentType)
  });
}

function createJobDownloadProgress(job, progressScope = {}) {
  if (!job) return null;
  let lastReportAt = 0;
  const itemIndex = Math.max(0, Number(progressScope.itemIndex || 0));
  const itemTotal = Math.max(1, Number(progressScope.itemTotal || 1));
  return ({ loaded, total }) => {
    const now = Date.now();
    const itemRatio = total ? loaded / total : 0;
    const progress = total
      ? Math.min(100, Math.round(((itemIndex + itemRatio) / itemTotal) * 100))
      : Math.min(100, Math.round((itemIndex / itemTotal) * 100) + 5);
    if (now - lastReportAt < 600 && progress < 100) return;
    lastReportAt = now;
    updateJob(job, {
      phase: "downloading",
      progress,
      phaseProgress: progress,
      bytesLoaded: loaded,
      bytesTotal: total || 0
    });
  };
}

async function fetchUploadFileWithProgress(url, onProgress = null, signal = null, {
  fallbackType = "application/octet-stream",
  maxBytes = 0,
  prefix = "media",
  resolveFilename = () => "media.bin"
} = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AppError(Err.DOWNLOAD_ERROR, `${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("Content-Length") || 0);
  assertTelegramUploadSize(total, "photo");
  assertMaxDownloadBytes(total, maxBytes, "photo");
  const contentType = response.headers.get("Content-Type") || fallbackType;
  const uploadFile = await createTempUploadFile({
    prefix,
    filename: resolveFilename(contentType),
    contentType
  });
  const writeStream = createUploadFileWriteStream(uploadFile);

  try {
    let loaded = 0;
    if (!response.body) {
      const chunk = new Uint8Array(await response.arrayBuffer());
      loaded = chunk.byteLength;
      assertMaxDownloadBytes(loaded, maxBytes, "photo");
      await writeChunk(writeStream, chunk);
      onProgress?.({ loaded, total: total || loaded });
    } else {
      const reader = response.body.getReader();
      while (true) {
        if (signal?.aborted) {
          throw new AppError(Err.CANCELLED, "Task cancelled by user.");
        }

        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        assertMaxDownloadBytes(loaded, maxBytes, "photo");
        await writeChunk(writeStream, value);
        onProgress?.({ loaded, total });
      }
      onProgress?.({ loaded, total: total || loaded });
    }

    uploadFile.size = loaded;
    await finishWriteStream(writeStream);
    return uploadFile;
  } catch (error) {
    writeStream.destroy();
    await cleanupUploadFile(uploadFile);
    throw error;
  }
}

function assertTelegramUploadSize(size, mediaType) {
  const limit = getTelegramUploadMaxBytes(mediaType);
  if (Number(size || 0) > limit) {
    const label = mediaType === "photo" ? "Image" : "Video";
    const limitMb = Math.round(limit / 1024 / 1024);
    throw new AppError(Err.TELEGRAM_API_ERROR, `${label} exceeds Telegram's ${limitMb} MB upload limit.`);
  }
}

function markDownloadedFilesSize(job, files) {
  if (!job) return;
  const size = files.reduce((total, file) => total + getUploadFileSize(file), 0);
  updateJob(job, {
    bytesLoaded: size,
    bytesTotal: size
  });
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

function assertMaxDownloadBytes(size, maxBytes, mediaType) {
  const limit = Number(maxBytes || 0);
  if (limit > 0 && Number(size || 0) > limit) {
    assertTelegramUploadSize(size, mediaType);
  }
}

function getTelegramUploadMaxBytes(mediaType) {
  return mediaType === "photo" ? TELEGRAM_PHOTO_UPLOAD_MAX_BYTES : TELEGRAM_FILE_UPLOAD_MAX_BYTES;
}

function parseByteLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isTelegramCloudApi() {
  return TELEGRAM_API_BASE === "https://api.telegram.org" || TELEGRAM_API_BASE === "http://api.telegram.org";
}

/** Create an upload progress callback that updates the given job. */
function createJobUploadProgress(job, progressScope = {}) {
  if (!job) {
    return null;
  }

  let lastReportAt = 0;
  const itemOffset = Math.max(0, Number(progressScope.itemOffset || 0));
  const itemCount = Math.max(1, Number(progressScope.itemCount || 1));
  const itemTotal = Math.max(1, Number(progressScope.itemTotal || 1));
  return ({ loaded, total }) => {
    const now = Date.now();
    const itemRatio = total ? loaded / total : 0;
    const progress = total
      ? Math.min(100, Math.round(((itemOffset + (itemCount * itemRatio)) / itemTotal) * 100))
      : Math.min(100, Math.round((itemOffset / itemTotal) * 100));
    if (now - lastReportAt < 600 && progress < 100) {
      return;
    }

    lastReportAt = now;
    updateJob(job, {
      phase: "uploading",
      progress,
      phaseProgress: progress,
      bytesLoaded: loaded,
      bytesTotal: total || 0
    });
  };
}







/** Singleton forward endpoint instance used by the server. */
export const forwardEndpoint = new NodeForwardEndpoint();
