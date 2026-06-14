import { AppError, Err } from "./errors.js";
import { readPersistedJobs, writePersistedJobs } from "./store.js";

const JOB_TTL_MS = Math.max(60 * 1000, Number(process.env.JOB_TTL_MS || 30 * 60 * 1000));

/** In-memory store of active forward jobs, keyed by job ID. */
export const jobs = new Map();

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
  job.sendEvent = (event, data) => sendSse(res, event, data);
  sendSse(res, "progress", serializeJob(job));

  try {
    updateJob(job, { status: "sending", phase: "pending", progress: 0, phaseProgress: 0 });
    const result = await forwardEndpoint.forward(innerPayload, innerTelegram, job);
    updateJob(job, {
      status: "sent",
      phase: "sent",
      progress: 100,
      phaseProgress: 100,
      result,
      completedAt: Date.now()
    });
    sendSse(res, "result", { ok: true, result, job: serializeJob(job) });
  } catch (error) {
    console.error("Forward stream failed:", error);
    updateJob(job, {
      status: "error",
      error: error instanceof AppError ? error : new AppError(Err.UNKNOWN, error.message || String(error)),
      completedAt: Date.now()
    });
    sendSse(res, "error", { ok: false, error: job.error, job: serializeJob(job) });
  } finally {
    res.end();
  }
}

/** Execute a forward job asynchronously, updating status as stages complete. */
export async function runForwardJob(job, forwardEndpoint) {
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
    updateJob(job, {
      status: "error",
      error: error instanceof AppError ? error : new AppError(Err.UNKNOWN, error.message || String(error)),
      completedAt: Date.now()
    });
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
    if ((job.updatedAt || job.completedAt || job.createdAt) < expiresBefore) {
      jobs.delete(id);
    }
  }
  persistJobs();
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
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
