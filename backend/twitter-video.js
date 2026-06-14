import { AppError, Err } from "./errors.js";
import { checkCancelled, updateJob } from "./jobs.js";

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
export async function downloadTwitterVideo(payload, job = null, progressScope = {}) {
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
        return downloadM3u8Video(candidate, job, progressScope);
      }

      checkCancelled(job);
      const blob = await fetchVideoBlob(candidate, createJobDownloadProgress(job, progressScope), signal);
      return { blob, size: blob.size, filename: "twitter-video.mp4" };
    } catch (error) {
      if (error.message === "Task cancelled by user") throw error;
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

  return [...new Set(urls)].filter(isDownloadableTwitterVideoUrl).sort(rankVideoUrl);
}

/** Check if a URL points to a downloadable Twitter video resource. */
function isDownloadableTwitterVideoUrl(url) {
  if (typeof url !== "string" || !VIDEO_HOST_PATTERN.test(url)) {
    return false;
  }

  return url.includes(".m3u8") || (url.includes(".mp4") && !/\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url));
}

/** Sort two video URLs by quality (highest resolution first). */
function rankVideoUrl(a, b) {
  const aIsMp4 = a.includes(".mp4") ? 1 : 0;
  const bIsMp4 = b.includes(".mp4") ? 1 : 0;
  return aIsMp4 !== bIsMp4 ? bIsMp4 - aIsMp4 : getVideoUrlPixels(b) - getVideoUrlPixels(a);
}

/** Extract the resolution pixel count from a Twitter video URL. */
function getVideoUrlPixels(url) {
  const match = url.match(/\/(\d+)x(\d+)\//);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

/** Fetch a video URL as a Blob with optional progress reporting and abort support. */
async function fetchVideoBlob(url, onProgress = null, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AppError(Err.DOWNLOAD_ERROR, `${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("Content-Length") || 0);
  if (!response.body || !onProgress) {
    const blob = await response.blob();
    if (onProgress) {
      onProgress({ loaded: blob.size, total: total || blob.size });
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
    onProgress({ loaded, total });
  }

  onProgress({ loaded, total: total || loaded });
  return new Blob(chunks, { type: response.headers.get("Content-Type") || "video/mp4" });
}

/** Download an HLS (m3u8) video stream by fetching and concatenating all segments. */
async function downloadM3u8Video(url, job = null, progressScope = {}) {
  checkCancelled(job);
  const signal = job?.abortController?.signal;
  const playlist = await fetchText(url, signal);
  const audioPlaylistUrl = resolveBestAudioPlaylistUrl(url, playlist);
  const mediaPlaylistUrl = resolveBestPlaylistUrl(url, playlist);
  if (audioPlaylistUrl && mediaPlaylistUrl !== url) {
    throw new AppError(Err.UNSUPPORTED_FORMAT, "This video uses separate HLS audio/video streams; the backend does not merge them into MP4 yet.");
  }

  const mediaPlaylist = mediaPlaylistUrl === url ? playlist : await fetchText(mediaPlaylistUrl);
  const parts = parseMediaPlaylist(mediaPlaylistUrl, mediaPlaylist);
  if (!parts.length) {
    throw new AppError(Err.DOWNLOAD_FAILED, "No HLS video segments were found.");
  }

  const blobs = [];
  for (let index = 0; index < parts.length; index += 1) {
    checkCancelled(job);
    const progress = createJobDownloadProgress(job, {
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
