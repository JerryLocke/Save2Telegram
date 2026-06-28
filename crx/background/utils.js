function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createCancelledError());
      return;
    }
    const timeoutId = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timeoutId);
      reject(createCancelledError());
    }, { once: true });
  });
}
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createCancelledError();
  }
}
function createCancelledError() {
  const error = new Error("Task cancelled by user.");
  error.code = "CANCELLED";
  return error;
}
/** Format bytes as a human-readable string for debug logs. */
function formatDebugBytes(bytes) {
  if (!bytes) {
    return "--";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)}${units[unitIndex]}`;
}
/** Format milliseconds as a human-readable duration string. */
function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${Math.round(ms / 1000)}s`;
}
