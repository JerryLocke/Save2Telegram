import { AppError, Err } from "./errors.js";
import { buildCaption } from "./caption.js";
import { checkCancelled, updateJob } from "./jobs.js";
import { downloadTwitterVideo } from "./twitter-video.js";
import { callTelegramMultipart, sendTelegramMessage, sendTelegramPhoto, sendTelegramVideoFile, validateTelegramChat } from "./telegram.js";

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
      const videoFile = await downloadTwitterVideo({ ...payload, media }, job);
      updateJob(job, {
        phase: "uploading",
        phaseProgress: 0,
        progress: 0,
        bytesLoaded: videoFile.size || videoFile.blob.size || 0,
        bytesTotal: videoFile.size || videoFile.blob.size || 0
      });
      return sendTelegramVideoFile(botToken, chatId, videoFile, caption, {
        signal,
        onUploadProgress: createJobUploadProgress(job)
      });
    }

    if (!media?.url || media.url.startsWith("blob:")) {
      updateJob(job, { phase: "uploading", phaseProgress: 0, progress: 0 });
      return sendTelegramMessage(botToken, chatId, caption || tweetUrl, signal);
    }

    updateJob(job, { phase: "uploading", phaseProgress: 100, progress: 100 });
    return sendTelegramPhoto(botToken, chatId, media.url, caption, signal);
  }
}

/** Extract and filter media items from a tweet payload (photo and video only). */
export function getPayloadMediaItems(payload) {
  const mediaItems = Array.isArray(payload?.mediaItems) ? payload.mediaItems : [];
  const items = mediaItems.length ? mediaItems : (payload?.media ? [payload.media] : []);
  return items.filter((item) => item?.type === "photo" || item?.type === "video");
}

/** Send multiple media items as a Telegram album (media group). Max 10 items. */
async function forwardTelegramMediaGroup(botToken, chatId, payload, mediaItems, caption, job = null) {
  const form = new FormData();
  const album = [];
  let attachmentIndex = 0;
  const albumItems = mediaItems.slice(0, 10);
  const downloadableVideos = albumItems.filter((item) => item.type === "video");

  for (const item of albumItems) {
    if (item.type === "photo" && item.url && !item.url.startsWith("blob:")) {
      album.push({ type: "photo", media: item.url });
      continue;
    }

    if (item.type === "video") {
      const videoFile = await downloadTwitterVideo({ ...payload, media: item }, job, {
        itemIndex: attachmentIndex,
        itemTotal: downloadableVideos.length || 1
      });
      const attachmentName = `video${attachmentIndex}`;
      attachmentIndex += 1;
      form.set(attachmentName, videoFile.blob, videoFile.filename);
      album.push({ type: "video", media: `attach://${attachmentName}`, supports_streaming: true });
    }
  }

  if (!album.length) {
    checkCancelled(job);
    return sendTelegramMessage(botToken, chatId, caption || payload?.tweetUrl || "", job?.abortController?.signal);
  }

  if (album.length === 1) {
    return sendSingleAlbumItem(botToken, chatId, album[0], caption, form, job);
  }

  if (caption) {
    album[0].caption = caption;
    album[0].parse_mode = "HTML";
  }

  form.set("chat_id", chatId);
  form.set("media", JSON.stringify(album));
  updateJob(job, { phase: "uploading", phaseProgress: 0, progress: 0 });
  checkCancelled(job);
  return callTelegramMultipart(botToken, "sendMediaGroup", form, {
    signal: job?.abortController?.signal,
    onUploadProgress: createJobUploadProgress(job)
  });
}

/** Send a single media item from an album, falling back to single-media API. */
async function sendSingleAlbumItem(botToken, chatId, item, caption, form, job = null) {
  if (item.type === "photo") {
    return sendTelegramPhoto(botToken, chatId, item.media, caption, job?.abortController?.signal);
  }

  const attachName = item.media.replace("attach://", "");
  const file = form.get(attachName);
  return sendTelegramVideoFile(botToken, chatId, {
    blob: file,
    filename: file?.name || "twitter-video.mp4"
  }, caption, {
    signal: job?.abortController?.signal,
    onUploadProgress: createJobUploadProgress(job)
  });
}

/** Create an upload progress callback that updates the given job. */
function createJobUploadProgress(job) {
  if (!job) {
    return null;
  }

  let lastReportAt = 0;
  return ({ loaded, total }) => {
    const now = Date.now();
    const progress = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
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
