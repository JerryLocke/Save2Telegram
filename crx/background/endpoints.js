/** Base class for forward endpoint implementations (local or remote). */
class ForwardEndpoint {
  constructor(settings) {
    this.settings = settings;
  }
  async forward() {
    throw new Error("ForwardEndpoint.forward must be implemented.");
  }
}
/** Forward endpoint that communicates directly with the Telegram Bot API. */
class LocalForwardEndpoint extends ForwardEndpoint {
  /** Forward tweet media via local Telegram API calls. */
  async forward(payload, queueItemId, configId = "", options = {}) {
    return forwardTwitterMediaLocal(this, payload, queueItemId, configId, options);
  }
  async validateChat(botToken, chatId, signal = null) {
    return validateTelegramChat(botToken, chatId, signal);
  }
  async downloadVideo(payload, queueItemId, progressScope = {}, signal = null) {
    return downloadTwitterVideo(payload, queueItemId, progressScope, signal);
  }
  async downloadPhoto(media, queueItemId, progressScope = {}, signal = null) {
    return downloadTwitterPhoto(media, queueItemId, progressScope, signal);
  }
  async sendPhoto(botToken, chatId, photo, caption, queueItemId = "", signal = null) {
    return sendTelegramPhoto(botToken, chatId, photo, caption, queueItemId, signal);
  }
  async sendPhotoFile(botToken, chatId, photoFile, caption, queueItemId = "", signal = null) {
    return sendTelegramPhotoFile(botToken, chatId, photoFile, caption, queueItemId, signal);
  }
  async sendVideoFile(botToken, chatId, videoFile, caption, queueItemId = "", signal = null) {
    return sendTelegramVideoFile(botToken, chatId, videoFile, caption, queueItemId, signal);
  }
  async sendMessage(botToken, chatId, text, queueItemId = "", signal = null) {
    return sendTelegramMessage(botToken, chatId, text, queueItemId, signal);
  }
  async callMultipart(botToken, method, body, queueItemId = "", signal = null) {
    return callTelegramMultipartLogged(botToken, method, body, queueItemId, signal);
  }
}
/** Forward endpoint that communicates via a remote Node.js backend over SSE. */
class RemoteForwardEndpoint extends ForwardEndpoint {
  /**
     * Forwarding entry point between SW and remote endpoint.
     *
     * Communication path: Popup/UI <-> SW <-> Remote Endpoint
     *   - SW always writes progress to chrome.storage (forwardQueue).
     *   - Popup reads storage only via GET_FORWARD_QUEUE, regardless of local/remote mode.
     *   - Calls POST /api/forward (SSE) only; the first progress event carries the backend-assigned job.id.
     *   - SW persists job.id as remoteJobId in the queue item, can recover after restart.
     *   - After SSE drops, SW falls back to polling GET /api/forward-jobs/:id via job.id.
     *   - Old expired jobs (404) report an error; users can retry from the popup to clear remoteJobId.
     */
  /** Forward tweet media via local Telegram API calls. */
  async forward(payload, queueItemId, configId = "", options = {}) {
    const endpointUrl = this.settings.endpointUrl;
    const config = await getTelegramConfigForSend(configId);
    const caption = buildCaption(payload);
    const mediaItems = getPayloadMediaItems(payload).map(item => ({
      type: item.type,
      url: item.url,
      candidates: item.candidates || [],
      thumbnail: item.thumbnail || '',
      order: item.order || 0,
      draftMediaKey: item.draftMediaKey || "",
      draftSourceKey: item.draftSourceKey || ""
    }));
    const requestBody = {
      payload: { tweetUrl: payload.tweetUrl || "", caption, mediaItems },
      telegram: { botToken: config.botToken, chatId: config.chatId }
    };
    // 1) Check for existing remoteJobId (recovery after SW restart)
    const queue = await getQueue();
    const item = queue.find(i => i.id === queueItemId);
    const existingJobId = item?.remoteJobId;
    if (existingJobId) {
      const resumed = await this._tryResumeJob(endpointUrl, existingJobId, queueItemId, options.signal);
      if (resumed !== null) return resumed;
      // Old job expired -> report error, do not auto-rebuild, user can retry manually in popup
      throw new Error(`Previous job ${existingJobId} has expired. Please retry manually in the popup`);
    }
    // 2) No old job, create new SSE connection
    let jobId = null;
    try {
      jobId = await this._streamWithSse(endpointUrl, requestBody, queueItemId, options.signal);
    } catch (sseError) {
      jobId = sseError.jobId || jobId;
      if (sseError.message === "_SSE_STREAM_ENDED_") {
        if (jobId) {
          await this._pollJob(endpointUrl, jobId, queueItemId, options.signal);
        } else {
          throw new Error("SSE connection lost and unable to retrieve job ID");
        }
      } else {
        throw sseError;
      }
    }
  }
  /** Try to resume an existing backend task. Returns null if expired and needs rebuild */
  async _tryResumeJob(endpointUrl, jobId, queueItemId, signal = null) {
    const res = await fetch(`${endpointUrl}/api/forward-jobs/${encodeURIComponent(jobId)}`, {
      headers: getEndpointAuthHeaders(this.settings),
      signal
    });
    if (res.status === 404) {
      await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
      return null;
    }
    if (!res.ok) {
      throw new Error(`Progress query failed: ${res.status}`);
    }
    const data = await res.json().catch(() => null);
    if (!data?.ok || !data?.job) {
      throw new Error("Progress response malformed");
    }
    const job = data.job;
    await removeSentDraftMediaKeysByQueueItem(queueItemId, job.sentDraftMediaKeys);
    if (job.status === "sent") return job.result;
    if (job.status === "cancelled") {
      await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
      throw createCancelledError();
    }
    if (job.status === "error") {
      await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
      const err = new Error(job.error || "Backend forward failed");
      err.code = job.errorCode || "TELEGRAM_API_ERROR";
      err.retryAfter = Number(job.retryAfter || 0);
      throw err;
    }
    await this._pollJob(endpointUrl, jobId, queueItemId, signal);
    return undefined;
  }
  /** Establish SSE connection via POST /api/forward, read progress events, return backend-assigned job.id */
  async _streamWithSse(endpointUrl, requestBody, queueItemId, signal = null) {
    const response = await fetch(`${endpointUrl}/api/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getEndpointAuthHeaders(this.settings) },
      body: JSON.stringify(requestBody),
      signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let jobId = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = this._parseSse(buffer);
      buffer = remainder;
      for (const { event, data } of events) {
        if (event === "progress" && data?.id) {
          if (!jobId) {
            jobId = data.id;
            await markQueueItem(queueItemId, { remoteJobId: jobId });
          }
          await removeSentDraftMediaKeysByQueueItem(queueItemId, data.sentDraftMediaKeys);
          await markQueueItem(queueItemId, {
            phase: data.phase || "pending",
            progress: data.progress || 0,
            phaseProgress: data.phaseProgress || 0,
            bytesLoaded: data.bytesLoaded || 0,
            bytesTotal: data.bytesTotal || 0,
            updatedAt: Date.now()
          });
        } else if (event === "result") {
          return jobId;
        } else if (event === "error") {
          await removeSentDraftMediaKeysByQueueItem(queueItemId, data?.sentDraftMediaKeys || data?.job?.sentDraftMediaKeys);
          await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
          const err = new Error(data?.error || "Backend forward failed");
          err.code = data?.code || "TELEGRAM_API_ERROR";
          err.retryAfter = Number(data?.retryAfter || data?.job?.retryAfter || 0);
          throw err;
        }
      }
    }
    const err = new Error("_SSE_STREAM_ENDED_");
    err.jobId = jobId;
    throw err;
  }
  _parseSse(buffer) {
    const events = [];
    const blocks = buffer.split("\n\n");
    const remainder = blocks.pop() || "";
    for (const block of blocks) {
      if (!block.trim()) continue;
      let event = "message";
      let rawData = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) rawData += line.slice(6);
      }
      let data = null;
      try { data = JSON.parse(rawData); } catch { }
      events.push({ event, data });
    }
    return { events, remainder };
  }
  async _pollJob(endpointUrl, jobId, queueItemId, signal = null) {
    const POLL_INTERVAL_MS = 800;
    const MAX_POLLS = 2250;
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS, signal);
      const res = await fetch(`${endpointUrl}/api/forward-jobs/${encodeURIComponent(jobId)}`, {
        headers: getEndpointAuthHeaders(this.settings),
        signal
      });
      if (!res.ok) throw new Error(`Progress query failed: ${res.status}`);
      const data = await res.json().catch(() => null);
      if (!data?.ok || !data?.job) throw new Error("Progress response malformed");
      const job = data.job;
      await removeSentDraftMediaKeysByQueueItem(queueItemId, job.sentDraftMediaKeys);
      await markQueueItem(queueItemId, {
        phase: job.phase || "pending",
        progress: job.progress || 0,
        phaseProgress: job.phaseProgress || 0,
        bytesLoaded: job.bytesLoaded || 0,
        bytesTotal: job.bytesTotal || 0,
        updatedAt: Date.now()
      });
      if (job.status === "sent") return job.result;
      if (job.status === "cancelled") {
        await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
        throw createCancelledError();
      }
      if (job.status === "error") {
        await markQueueItem(queueItemId, { remoteJobId: "", updatedAt: Date.now() });
        const err = new Error(job.error || "Backend forward failed");
        err.code = job.errorCode || "TELEGRAM_API_ERROR";
        err.retryAfter = Number(job.retryAfter || 0);
        throw err;
      }
    }
    throw new Error(`Job ${jobId} timed out (30 min). You can query it by this ID on the backend`);
  }
}
/** Factory: create the appropriate ForwardEndpoint based on current settings. */
async function createForwardEndpoint() {
  const settings = await getGeneralSettings();
  return settings.endpointUrl && settings.endpointKey
    ? new RemoteForwardEndpoint(settings)
    : new LocalForwardEndpoint(settings);
}
/** Build authorization headers for a remote endpoint request. */
function getEndpointAuthHeaders(settings) {
  const key = String(settings?.endpointKey || "").trim();
  return key ? { "Authorization": `Bearer ${key}` } : {};
}
/** Forward tweet media through a local endpoint, handling photos, videos, and media groups. */
async function forwardTwitterMediaLocal(endpoint, payload, queueItemId, configId = "", options = {}) {
  const signal = options?.signal || null;
  const config = await getTelegramConfigForSend(configId);
  const { botToken, chatId } = config;
  if (!botToken || !chatId) {
    throw new Error(__t("bg_configureFirst"));
  }
  const configLabel = getTelegramConfigLabel(config); try { await endpoint.validateChat(botToken, chatId, signal); } catch (validateError) { throw new Error(`Channel "${configLabel}" validation failed: ${validateError.message}`); }
  const tweetUrl = payload?.tweetUrl || "";
  const caption = buildCaption(payload);
  const mediaItems = getPayloadMediaItems(payload);
  await appendQueueDebugLog(queueItemId, `Parsed media: ${mediaItems.length} item(s)`);
  if (!mediaItems.length) {
    await appendQueueDebugLog(queueItemId, "No media, sending text message");
    return endpoint.sendMessage(botToken, chatId, caption || tweetUrl, queueItemId, signal);
  }
  if (mediaItems.length > 1) {
    await appendQueueDebugLog(queueItemId, "Sending media group");
    return forwardTelegramMediaGroup(endpoint, botToken, chatId, payload, mediaItems, caption, queueItemId, signal);
  }
  const media = mediaItems[0];
  if (media?.type === "video") {
    await appendQueueDebugLog(queueItemId, "Downloading video");
    const videoFile = await endpoint.downloadVideo({ ...payload, media }, queueItemId, {
      itemIndex: 0,
      itemTotal: 1
    }, signal);
    assertTelegramUploadSize(videoFile.size || videoFile.blob.size || 0, "video");
    await markTelegramUploadProgress(queueItemId, videoFile);
    const result = await endpoint.sendVideoFile(botToken, chatId, videoFile, caption, queueItemId, signal);
    await removeSentQueueMedia(queueItemId, [media]);
    return result;
  }
  if (!media?.url || media.url.startsWith("blob:")) {
    await appendQueueDebugLog(queueItemId, "Media URL cannot be sent directly, falling back to text message");
    return endpoint.sendMessage(botToken, chatId, caption || tweetUrl, queueItemId, signal);
  }
  await appendQueueDebugLog(queueItemId, "Downloading photo");
  const photoFile = await endpoint.downloadPhoto(media, queueItemId, {
    itemIndex: 0,
    itemTotal: 1
  }, signal);
  assertTelegramUploadSize(photoFile.size || photoFile.blob.size || 0, "photo");
  await markTelegramUploadProgress(queueItemId, photoFile);
  const result = await endpoint.sendPhotoFile(botToken, chatId, photoFile, caption, queueItemId, signal);
  await removeSentQueueMedia(queueItemId, [media]);
  return result;
}
/** Extract and filter media items (photo/video) from a tweet payload. */
function getPayloadMediaItems(payload) {
  const mediaItems = Array.isArray(payload?.mediaItems) ? payload.mediaItems : [];
  const items = mediaItems.length ? mediaItems : (payload?.media ? [payload.media] : []);
  return items.filter((item) => item?.type === "photo" || item?.type === "video");
}
function assertForwardablePayload(payload) {
  const mediaItems = getPayloadMediaItems(payload);
  if (!mediaItems.length) {
    throw new Error(__t("bg_noMedia"));
  }

  if (mediaItems.some((media) => media.type === "video" && !hasDownloadableVideoCandidate(media))) {
    throw new Error(__t("bg_noDownloadableVideo"));
  }
}
function hasDownloadableVideoCandidate(media) {
  return [
    media?.url,
    ...(Array.isArray(media?.candidates) ? media.candidates : [])
  ]
    .map((url) => typeof url === "string" ? cleanEscapedUrl(url) : "")
    .some((url) => url && !url.startsWith("blob:") && isDownloadableTwitterVideoUrl(url));
}
function cleanEscapedUrl(url) {
  return url
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&")
    .replace(/\\u0026/g, "&");
}
