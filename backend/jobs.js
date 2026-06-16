import { AppError, Err } from "./errors.js";
import { readPersistedJobs, writePersistedJobs } from "./store.js";

const JOB_TTL_MS = Math.max(60 * 1000, Number(process.env.JOB_TTL_MS || 30 * 60 * 1000));
const MAX_CONCURRENT_FORWARD_JOBS = parsePositiveInteger(process.env.MAX_CONCURRENT_FORWARD_JOBS, 3);

/** In-memory store of active forward jobs, keyed by job ID. */
export const jobs = new Map();
const queuedForwardJobs = [];
const queuedForwardJobsById = new Map();
const activeForwardJobIds = new Set();

/** Load persisted jobs from disk on startup. */
export async function loadJobs() {
  const persistedJobs = await readPersistedJobs();
  const persistedArr = Array.isArray(persistedJobs) ? persistedJobs : [];
  for (const persisted of persistedArr) {
    if (!persisted?.id) {
      continue;
    }

    const status = ["pending", "sending"].includes(persisted.status) ? "error" : persisted.status;
    jobs.set(persisted.id, {
      ...persisted,
      status,
      error: status === "error" && ["pending", "sending"].includes(persisted.status)
        ? "Backend restarted before this job completed."
        : (persisted.error || ""),
      abortController: new AbortController()
    });
  }
  cleanupJobs();
}

/** Create a new forward job record with a unique ID and initial status. */
export function createForwardJob(payload, telegram, uid = "") {
  cleanupJobs();
  const now = Date.now();
  const job = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    uid,
    status: "pending",
    phase: "pending",
    progress: 0,
    phaseProgress: 0,
    bytesLoaded: 0,
    bytesTotal: 0,
    result: null,
    error: "",
    payload,
    telegram,
    cancelled: false,
    abortController: new AbortController(),
    createdAt: now,
    updatedAt: now,
    completedAt: 0
  };
  jobs.set(job.id, job);
  persistJobs();
  return job;
}

/** Forward media with real-time progress via Server-Sent Events (SSE). */
export async function streamForward(res, payload, telegram, forwardEndpoint, uid = "") {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });

  // The request body may be either the payload itself or a wrapper with
  // payload/telegram fields. Normalize to the inner payload before sending.
  const innerPayload = (payload && typeof payload === "object" && "tweetUrl" in payload)
    ? payload
    : (payload?.payload || payload || {});
  const innerTelegram = telegram || payload?.telegram || {};
  const job = createForwardJob(innerPayload, innerTelegram, uid);
  job.sendEvent = (event, data) => {
    if (!sendSse(res, event, data)) {
      job.sendEvent = null;
    }
  };
  res.on?.("close", () => {
    job.sendEvent = null;
  });
  sendSse(res, "progress", serializeJob(job));

  try {
    await enqueueForwardJob(job, forwardEndpoint);
    if (job.status === "sent") {
      sendSse(res, "result", { ok: true, result: job.result, job: serializeJob(job) });
    } else {
      sendSse(res, "error", { ok: false, error: job.error || "Forward job did not complete.", job: serializeJob(job) });
    }
  } finally {
    res.end();
  }
}

/** Queue a forward job and resolve after it reaches a terminal state. */
export function enqueueForwardJob(job, forwardEndpoint) {
  cleanupJobs();
  return new Promise((resolve) => {
    const entry = { job, forwardEndpoint, resolve };
    queuedForwardJobs.push(entry);
    queuedForwardJobsById.set(job.id, entry);
    updateJob(job, { status: "pending", phase: "queued", progress: 0, phaseProgress: 0 });
    drainForwardJobQueue();
  });
}

/** Cancel a queued or active job and resolve any pending queue waiter. */
export function cancelForwardJob(job, message = "Task cancelled by user.") {
  if (!job) {
    return null;
  }

  job.abortController?.abort();
  job.cancelled = true;
  updateJob(job, { status: "cancelled", error: message, completedAt: Date.now() });

  const queued = queuedForwardJobsById.get(job.id);
  if (queued) {
    queuedForwardJobsById.delete(job.id);
    queued.resolve?.(job);
    drainForwardJobQueue();
  }

  return job;
}

/** Execute a forward job asynchronously, updating status as stages complete. */
export async function runForwardJob(job, forwardEndpoint) {
  if (job?.cancelled || job?.abortController?.signal?.aborted || job?.status === "cancelled") {
    updateJob(job, { status: "cancelled", error: "Task cancelled by user.", completedAt: Date.now() });
    return;
  }

  updateJob(job, { status: "sending", phase: "pending", progress: 0, phaseProgress: 0 });
  try {
    const result = await forwardEndpoint.forward(job.payload, job.telegram, job);
    updateJob(job, {
      status: "sent",
      phase: "sent",
      progress: 100,
      phaseProgress: 100,
      result,
      completedAt: Date.now()
    });
  } catch (error) {
    console.error("Forward job failed:", error);
    const appError = error instanceof AppError ? error : new AppError(Err.UNKNOWN, error.message || String(error));
    updateJob(job, {
      status: job?.cancelled || appError.code === Err.CANCELLED ? "cancelled" : "error",
      error: appError,
      completedAt: Date.now()
    });
  }
}

function drainForwardJobQueue() {
  while (activeForwardJobIds.size < MAX_CONCURRENT_FORWARD_JOBS && queuedForwardJobs.length) {
    const item = queuedForwardJobs.shift();
    if (!item?.job) {
      continue;
    }
    if (queuedForwardJobsById.get(item.job.id) !== item) {
      continue;
    }
    queuedForwardJobsById.delete(item.job.id);
    runQueuedForwardJob(item);
  }
}

async function runQueuedForwardJob({ job, forwardEndpoint, resolve }) {
  activeForwardJobIds.add(job.id);
  try {
    await runForwardJob(job, forwardEndpoint);
  } finally {
    activeForwardJobIds.delete(job.id);
    resolve?.(job);
    drainForwardJobQueue();
  }
}

/** Apply a partial update to a job and persist it. */
export function updateJob(job, patch) {
  if (!job) {
    return;
  }

  // Extract errorCode from AppError instances
  if (patch.error && typeof patch.error === "object" && patch.error instanceof AppError) {
    patch.errorCode = patch.error.code;
    patch.retryAfter = Number(patch.error.retryAfter || 0);
    patch.error = patch.error.message;
  }

  Object.assign(job, patch, { updatedAt: Date.now() });
  persistJobs();
  if (typeof job.sendEvent === "function") {
    job.sendEvent("progress", serializeJob(job));
  }
}

/** Mark a job as recently active so cleanup does not evict it. */
export function touchJob(job) {
  if (!job) {
    return;
  }

  job.updatedAt = Date.now();
  persistJobs();
}

/** Serialize a job for JSON transmission (strip runtime-only fields). */
export function serializeJob(job) {
  return {
    id: job.id,
    uid: job.uid || "",
    status: job.cancelled ? "cancelled" : job.status,
    phase: job.phase,
    progress: clampProgress(job.progress),
    phaseProgress: clampProgress(job.phaseProgress),
    bytesLoaded: Number(job.bytesLoaded || 0),
    bytesTotal: Number(job.bytesTotal || 0),
    result: job.result,
    error: job.error,
    errorCode: job.errorCode || "",
    retryAfter: Number(job.retryAfter || 0),
    cancelled: Boolean(job.cancelled),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  };
}

/** Remove stale jobs older than the retention window. */
export function cleanupJobs() {
  const expiresBefore = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (isLiveJob(job)) {
      continue;
    }
    if ((job.updatedAt || job.completedAt || job.createdAt) < expiresBefore) {
      jobs.delete(id);
    }
  }
  persistJobs();
}

function isLiveJob(job) {
  return !job?.completedAt &&
    !job?.cancelled &&
    (job?.status === "pending" || job?.status === "sending" || activeForwardJobIds.has(job?.id));
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/** Clamp a progress value to 0-100. */
function clampProgress(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

/** Check if a job has been cancelled and throw if so. */
export function checkCancelled(job) {
  if (job?.abortController?.signal?.aborted) {
    throw new AppError(Err.CANCELLED, "Task cancelled by user.");
  }
}

/** Send a Server-Sent Events frame (event + data) over the HTTP response. */
function sendSse(res, event, data) {
  if (!res || res.destroyed || res.writableEnded) {
    return false;
  }

  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Serialize a job for disk persistence (strip runtime objects). */
function serializeJobForStorage(job) {
  return {
    ...serializeJob(job),
    payload: job.payload,
    telegram: job.telegram
  };
}

/** Write all active jobs to disk. */
function persistJobs() {
  writePersistedJobs([...jobs.values()].map(serializeJobForStorage)).catch((error) => {
    console.error("Failed to persist jobs:", error);
  });
}
