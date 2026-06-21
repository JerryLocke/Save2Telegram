import { AppError, Err } from "./errors.js";
import { checkCancelled, updateJob } from "./jobs.js";
import { cleanupUploadFile, createTempUploadFile, createUploadFileWriteStream, finishWriteStream, writeChunk } from "./upload-file.js";

const VIDEO_HOST_PATTERN = /^https:\/\/video\.twimg\.com\//;

/** Create a download progress reporter that updates the given job. */
function createJobDownloadProgress(job, progressScope = {}) {
  if (!job) return null;
  let lastReportAt = 0;
  const itemIndex = Math.max(0, Number(progressScope.itemIndex || 0));
  const itemTotal = Math.max(1, Number(progressScope.itemTotal || 1));
  const partIndex = Math.max(0, Number(progressScope.partIndex || 0));
  const partTotal = Math.max(1, Number(progressScope.partTotal || 1));
  return ({ loaded, total }) => {
    const now = Date.now();
    const partRatio = total ? loaded / total : 0;
    const itemRatio = (partIndex + partRatio) / partTotal;
    const progress = total
      ? Math.min(100, Math.round(((itemIndex + itemRatio) / itemTotal) * 100))
      : Math.min(100, Math.round((itemIndex / itemTotal) * 100) + 5);
    if (now - lastReportAt < 600 && progress < 100) return;
    lastReportAt = now;
    updateJob(job, {
      phase: "downloading",
      progress,
      phaseProgress: progress,
      bytesLoaded: partTotal > 1 ? 0 : loaded,
      bytesTotal: partTotal > 1 ? 0 : (total || 0)
    });
  };
}

/** Download a Twitter/X video from the best available candidate URL. */
export async function downloadTwitterVideo(payload, job = null, progressScope = {}, options = {}) {
  checkCancelled(job);
  const itemIndex = Math.max(0, Number(progressScope.itemIndex || 0));
  const itemTotal = Math.max(1, Number(progressScope.itemTotal || 1));
  updateJob(job, {
    phase: "downloading",
    phaseProgress: Math.round((itemIndex / itemTotal) * 100),
    progress: Math.round((itemIndex / itemTotal) * 100),
    bytesLoaded: 0,
    bytesTotal: 0
  });
  const signal = job?.abortController?.signal;
  const candidates = normalizeVideoCandidates(payload?.media || {});
  if (!candidates.length) {
    throw new AppError(Err.NO_MEDIA_SOURCE, "No downloadable video URL found.");
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      if (candidate.includes(".m3u8")) {
        return await downloadM3u8Video(candidate, job, progressScope, options);
      }

      checkCancelled(job);
      return await fetchVideoFile(candidate, {
        filename: "twitter-video.mp4",
        fallbackType: "video/mp4",
        maxBytes: options.maxBytes,
        onProgress: createJobDownloadProgress(job, progressScope),
        signal
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || error?.code === Err.CANCELLED || error?.message === "Task cancelled by user.") {
        throw new AppError(Err.CANCELLED, "Task cancelled by user.");
      }
      errors.push(error.message || String(error));
    }
  }

  throw new AppError(Err.DOWNLOAD_FAILED, `Video download failed: ${errors[0] || "no available video source"}`);
}

/** Extract and deduplicate video candidate URLs from media metadata. */
function normalizeVideoCandidates(media) {
  const urls = [
    media.url,
    ...(Array.isArray(media.candidates) ? media.candidates : [])
  ].filter((url) => typeof url === "string" && url && !url.startsWith("blob:"));

  return [...new Set(urls)].filter(isDownloadableTwitterVideoUrl).sort(rankVideoUrlType);
}

/** Check if a URL points to a downloadable Twitter video resource. */
function isDownloadableTwitterVideoUrl(url) {
  if (typeof url !== "string" || !VIDEO_HOST_PATTERN.test(url)) {
    return false;
  }

  return url.includes(".m3u8") || (url.includes(".mp4") && !/\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url));
}

/** Prefer direct MP4 candidates while preserving the payload's quality order within each type. */
function rankVideoUrlType(a, b) {
  const aIsMp4 = a.includes(".mp4") ? 1 : 0;
  const bIsMp4 = b.includes(".mp4") ? 1 : 0;
  return bIsMp4 - aIsMp4;
}

/** Fetch a video URL into a temporary file with optional progress reporting. */
async function fetchVideoFile(url, {
  filename = "twitter-video.mp4",
  fallbackType = "video/mp4",
  maxBytes = 0,
  onProgress = null,
  signal = null
} = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AppError(Err.DOWNLOAD_ERROR, `${response.status} ${response.statusText}`);
  }

  // Fail before writing when the server declares a file too large for Telegram.
  assertWithinMaxBytes(Number(response.headers.get("Content-Length") || 0), maxBytes);
  const uploadFile = await createTempUploadFile({
    prefix: "twitter-video",
    filename,
    contentType: response.headers.get("Content-Type") || fallbackType
  });
  const writeStream = createUploadFileWriteStream(uploadFile);

  try {
    uploadFile.size = await appendResponseToFile(response, writeStream, {
      maxBytes,
      onProgress,
      signal
    });
    await finishWriteStream(writeStream);
    return uploadFile;
  } catch (error) {
    writeStream.destroy();
    await cleanupUploadFile(uploadFile);
    throw error;
  }
}

/** Download an HLS (m3u8) video stream by appending all segments to a temporary file. */
async function downloadM3u8Video(url, job = null, progressScope = {}, options = {}) {
  checkCancelled(job);
  const signal = job?.abortController?.signal;
  const playlist = await fetchText(url, signal);
  const audioPlaylistUrl = resolveBestAudioPlaylistUrl(url, playlist);
  const mediaPlaylistUrl = resolveBestPlaylistUrl(url, playlist);
  if (audioPlaylistUrl && mediaPlaylistUrl !== url) {
    throw new AppError(Err.UNSUPPORTED_FORMAT, "This video uses separate HLS audio/video streams; the backend does not merge them into MP4 yet.");
  }

  const mediaPlaylist = mediaPlaylistUrl === url ? playlist : await fetchText(mediaPlaylistUrl, signal);
  const parts = parseMediaPlaylist(mediaPlaylistUrl, mediaPlaylist);
  if (!parts.length) {
    throw new AppError(Err.DOWNLOAD_FAILED, "No HLS video segments were found.");
  }

  const isFragmentedMp4 = parts.some((partUrl) => /\.(m4s|cmfv|mp4)(\?|$)/.test(partUrl));
  const uploadFile = await createTempUploadFile({
    prefix: "twitter-video",
    filename: isFragmentedMp4 ? "twitter-video.mp4" : "twitter-video.ts",
    contentType: isFragmentedMp4 ? "video/mp4" : "video/mp2t"
  });
  const writeStream = createUploadFileWriteStream(uploadFile);
  let loaded = 0;

  // Keep one file open across segments to avoid holding each segment in memory.
  for (let index = 0; index < parts.length; index += 1) {
    try {
      checkCancelled(job);
      const progress = createJobDownloadProgress(job, {
        ...progressScope,
        partIndex: index,
        partTotal: parts.length
      });
      const response = await fetch(parts[index], { signal });
      if (!response.ok) {
        throw new AppError(Err.DOWNLOAD_ERROR, `${response.status} ${response.statusText}`);
      }

      const contentLength = Number(response.headers.get("Content-Length") || 0);
      assertWithinMaxBytes(contentLength ? loaded + contentLength : 0, options.maxBytes);
      loaded = await appendResponseToFile(response, writeStream, {
        initialLoaded: loaded,
        maxBytes: options.maxBytes,
        onProgress: progress,
        signal
      });
    } catch (error) {
      writeStream.destroy();
      await cleanupUploadFile(uploadFile);
      throw error;
    }
  }

  try {
    uploadFile.size = loaded;
    await finishWriteStream(writeStream);
    return uploadFile;
  } catch (error) {
    writeStream.destroy();
    await cleanupUploadFile(uploadFile);
    throw error;
  }
}

/** Append a fetch response body to an open temporary file. */
async function appendResponseToFile(response, writeStream, {
  initialLoaded = 0,
  maxBytes = 0,
  onProgress = null,
  signal = null
} = {}) {
  const total = Number(response.headers.get("Content-Length") || 0);
  let loaded = initialLoaded;
  let responseLoaded = 0;

  if (!response.body) {
    const chunk = new Uint8Array(await response.arrayBuffer());
    loaded += chunk.byteLength;
    assertWithinMaxBytes(loaded, maxBytes);
    await writeChunk(writeStream, chunk);
    onProgress?.({ loaded: chunk.byteLength, total: total || chunk.byteLength });
    return loaded;
  }

  const reader = response.body.getReader();
  while (true) {
    if (signal?.aborted) {
      throw new AppError(Err.CANCELLED, "Task cancelled by user.");
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    loaded += value.byteLength;
    responseLoaded += value.byteLength;
    assertWithinMaxBytes(loaded, maxBytes);
    await writeChunk(writeStream, value);
    onProgress?.({ loaded: responseLoaded, total });
  }

  onProgress?.({ loaded: responseLoaded, total: total || responseLoaded });
  return loaded;
}

function assertWithinMaxBytes(size, maxBytes = 0) {
  const limit = Number(maxBytes || 0);
  if (limit > 0 && Number(size || 0) > limit) {
    throw new AppError(Err.TELEGRAM_API_ERROR, `Video exceeds Telegram's ${formatMegabytes(limit)} MB upload limit.`);
  }
}

function formatMegabytes(bytes) {
  return Math.round(Number(bytes || 0) / 1024 / 1024);
}

/** Fetch a URL and return its response body as text. */
async function fetchText(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AppError(Err.DOWNLOAD_ERROR, `${response.status} ${response.statusText}`);
  }

  return response.text();
}

/** Find the best audio-only playlist URL from an HLS master playlist. */
function resolveBestAudioPlaylistUrl(baseUrl, playlist) {
  const audioVariants = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(line))
    .map((line) => ({
      url: line.match(/URI="([^"]+)"/)?.[1] || "",
      bitrate: Number(line.match(/GROUP-ID="audio-(\d+)"/)?.[1] || 0)
    }))
    .filter((variant) => variant.url);

  audioVariants.sort((a, b) => b.bitrate - a.bitrate);
  return audioVariants[0]?.url ? new URL(audioVariants[0].url, baseUrl).toString() : "";
}

/** Find the best quality video playlist URL from an HLS master playlist. */
function resolveBestPlaylistUrl(baseUrl, playlist) {
  const lines = playlist.split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const nextUrl = findNextPlaylistUrl(lines, index + 1);
    if (nextUrl) {
      variants.push({
        url: new URL(nextUrl, baseUrl).toString(),
        bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0),
        pixels: getResolutionPixels(line)
      });
    }
  }

  variants.sort((a, b) => (b.pixels - a.pixels) || (b.bandwidth - a.bandwidth));
  return variants[0]?.url || baseUrl;
}

/** Find the playlist URL following an EXT-X-STREAM-INF tag. */
function findNextPlaylistUrl(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line && !line.startsWith("#")) {
      return line;
    }
  }

  return "";
}

/** Extract resolution pixel count from an EXT-X-STREAM-INF line. */
function getResolutionPixels(line) {
  const match = line.match(/RESOLUTION=(\d+)x(\d+)/);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

/** Parse an HLS media playlist and return absolute segment URLs. */
function parseMediaPlaylist(baseUrl, playlist) {
  const parts = [];
  for (const line of playlist.split(/\r?\n/)) {
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
