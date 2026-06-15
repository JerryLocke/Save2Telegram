import http from "node:http";
import { APP_NAME, BACKEND_VERSION, EXTENSION_ID, HOST, PORT, PUBLIC_URL } from "./config.js";
import { AppError, Err } from "./errors.js";
import { forwardEndpoint } from "./forwarder.js";
import { createForwardJob, cleanupJobs, jobs, loadJobs, runForwardJob, serializeJob, streamForward, touchJob, updateJob } from "./jobs.js";
import { createRequestContext, logForwardRequest, logRequestEnd, logRequestStart } from "./logger.js";
import { getEndpointUrl, getRequestOrigin, normalizeEndpointUrl, readJsonBody, sendHtml, sendJson, sendOptions } from "./http-utils.js";
import { renderSetupPage, resolveSetupLocale } from "./setup-page.js";
import { createUserKey, requireSetupSecret, requireUserByBearer, SERVER_SECRET } from "./auth.js";
const NORMALIZED_PUBLIC_URL = normalizeEndpointUrl(PUBLIC_URL);
/** Main HTTP server: routes requests for setup, health, key management, and media forwarding. */
const server = http.createServer(async (req, res) => {
  const context = createRequestContext(req, res);
  logRequestStart(req, context);
  try {
    if (req.method === "OPTIONS") {
      return sendOptions(res);
    }
    const url = new URL(req.url || "/", getRequestOrigin(req, PORT));
    // GET / - Setup page (protected by secret if configured)
    if (req.method === "GET" && url.pathname === "/") {
      const setupSecret = String(url.searchParams.get("secret") || "");
      if (SERVER_SECRET && setupSecret !== SERVER_SECRET) {
        return sendHtml(res, renderNotFoundPage(), 404);
      }
      return sendHtml(res, renderSetupPage(
        getEndpointUrl(req, NORMALIZED_PUBLIC_URL, PORT),
        EXTENSION_ID,
        APP_NAME,
        BACKEND_VERSION,
        resolveSetupLocale(req, ""),
        Boolean(SERVER_SECRET),
        SERVER_SECRET ? setupSecret : ""
      ));
    }
    // GET /health - Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    // POST /api/keys - Create a new API key (requires setup secret)
    if (req.method === "POST" && url.pathname === "/api/keys") {
      requireSetupSecret(req);
      return sendJson(res, 201, { ok: true, ...(await createUserKey()) });
    }
    // POST /api/forward-jobs - Create an async forwarding job (returns immediately)
    if (req.method === "POST" && url.pathname === "/api/forward-jobs") {
      const user = await requireUserByBearer(req);
      const body = await readJsonBody(req);
      logForwardRequest(body, context);
      const job = createForwardJob(body?.payload, body?.telegram, user.uid);
      runForwardJob(job, forwardEndpoint);
      return sendJson(res, 202, { ok: true, job: serializeJob(job) });
    }
    // DELETE /api/forward-jobs/:id - Cancel a job
    // GET /api/forward-jobs/:id - Poll job status
    const jobMatch = url.pathname.match(/^\/api\/forward-jobs\/([^\/]+)$/);
    if (req.method === "DELETE" && jobMatch) {
      const user = await requireUserByBearer(req);
      cleanupJobs();
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { ok: false, code: Err.JOB_NOT_FOUND, error: "Job not found" });
      if (job.uid !== user.uid) return sendJson(res, 403, { ok: false, code: Err.FORBIDDEN, error: "Forbidden" });
      job.abortController?.abort();
      job.cancelled = true;
      updateJob(job, { status: "cancelled", error: "Task cancelled by user.", completedAt: Date.now() });
      return sendJson(res, 200, { ok: true, job: serializeJob(job) });
    }
    if (jobMatch && req.method === "GET") {
      const user = await requireUserByBearer(req);
      cleanupJobs();
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        return sendJson(res, 404, { ok: false, error: "Job not found" });
      }
      if (job.uid !== user.uid) return sendJson(res, 403, { ok: false, code: Err.FORBIDDEN, error: "Forbidden" });
      touchJob(job);
      return sendJson(res, 200, { ok: true, job: serializeJob(job) });
    }
    // POST /api/forward - Stream media forwarding via Server-Sent Events
    if (req.method === "POST" && url.pathname === "/api/forward") {
      const user = await requireUserByBearer(req);
      const body = await readJsonBody(req);
      logForwardRequest(body, context);
      context.isSse = true;
      return streamForward(res, body, body?.telegram, forwardEndpoint, user.uid);
    }
    sendJson(res, 404, { ok: false, code: "NOT_FOUND", error: "Not found" });
  } catch (error) {
    context.error = error.message || String(error);
    const code = error instanceof AppError ? error.code : Err.UNKNOWN;
    const status = code === Err.UNAUTHORIZED ? 401 : (code === Err.FORBIDDEN ? 403 : 500);
    sendJson(res, status, { ok: false, code, error: error.message || String(error) });
  } finally {
    logRequestEnd(req, context);
  }
});
// Restore persisted jobs on startup
await loadJobs();
server.listen(PORT, HOST, () => {
  const endpointUrl = NORMALIZED_PUBLIC_URL || `http://localhost:${PORT}`;
  const setupUrl = SERVER_SECRET
    ? `${endpointUrl}/?secret=${SERVER_SECRET}`
    : `${endpointUrl}/`;
  console.info(`${APP_NAME} backend v${BACKEND_VERSION} listening on ${HOST}:${PORT}`);
  console.info(`${APP_NAME} setup URL: ${setupUrl}`);
  if (EXTENSION_ID) {
    console.info(`${APP_NAME} extension store URL: https://chromewebstore.google.com/detail/${EXTENSION_ID}`);
  }
});
/** Render a simple 404 HTML page. */
function renderNotFoundPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>404 Not Found</title>
  </head>
  <body>
    <h1>404 Not Found</h1>
  </body>
</html>`;
}
