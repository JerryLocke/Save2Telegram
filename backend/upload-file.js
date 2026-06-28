import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = process.env.SAVE2TELEGRAM_TMP_DIR || path.join(os.tmpdir(), "save2telegram");

// Startup cleanup may run against a user-selected temp root, so only delete
// directories with prefixes created by createTempUploadFile().
const MANAGED_TEMP_PREFIXES = ["twitter-video-", "twitter-photo-", "media-"];

/** Create a temporary disk-backed upload file descriptor. */
export async function createTempUploadFile({
  prefix = "media",
  filename = "media.bin",
  contentType = "application/octet-stream"
} = {}) {
  await fs.promises.mkdir(TMP_ROOT, { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join(TMP_ROOT, `${sanitizePathSegment(prefix) || "media"}-`));
  const safeFilename = sanitizeFilename(filename) || "media.bin";
  const filePath = path.join(tempDir, safeFilename);

  return {
    path: filePath,
    tempDir,
    filename: safeFilename,
    name: safeFilename,
    type: contentType || "application/octet-stream",
    size: 0,
    // Telegram upload retries need a fresh stream each attempt.
    stream() {
      return fs.createReadStream(filePath);
    },
    async cleanup() {
      await cleanupUploadFile(this);
    }
  };
}

/** Open a write stream for a temporary upload file. */
export function createUploadFileWriteStream(uploadFile) {
  return fs.createWriteStream(uploadFile.path, { flags: "wx" });
}

/** Write a chunk to a Node write stream while respecting backpressure. */
export async function writeChunk(writeStream, chunk) {
  if (writeStream.write(chunk)) {
    return;
  }

  await waitForWriteStreamEvent(writeStream, "drain");
}

/** Finish a Node write stream and surface any write errors. */
export async function finishWriteStream(writeStream) {
  const finished = waitForWriteStreamEvent(writeStream, "finish");
  writeStream.end();
  await finished;
}

/** Return the byte size of either a disk-backed upload file or a Blob wrapper. */
export function getUploadFileSize(file) {
  return Number(file?.size || file?.blob?.size || 0);
}

/** Remove a temporary upload file and its private temp directory. */
export async function cleanupUploadFile(file) {
  if (!file || file.cleaned) {
    return;
  }

  file.cleaned = true;
  if (file.tempDir) {
    await fs.promises.rm(file.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove all temporary upload files in a best-effort manner. */
export async function cleanupUploadFiles(files) {
  await Promise.all((files || []).filter(Boolean).map((file) => cleanupUploadFile(file)));
}

/** Remove managed upload temp directories left behind by a hard process/container kill. */
export async function cleanupStaleUploadFiles() {
  const entries = await fs.promises.readdir(TMP_ROOT, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isManagedTempDir(entry.name)) {
      continue;
    }

    const target = path.join(TMP_ROOT, entry.name);
    await fs.promises.rm(target, { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function isManagedTempDir(name) {
  return MANAGED_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function sanitizeFilename(value) {
  const basename = path.basename(String(value || ""));
  return basename
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 120);
}

function waitForWriteStreamEvent(writeStream, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writeStream.off(eventName, onEvent);
      writeStream.off("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    writeStream.once(eventName, onEvent);
    writeStream.once("error", onError);
  });
}
