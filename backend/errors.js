/** Application-level error with a machine-readable error code. */
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AppError";
  }
}

/** Error code constants used across the backend. */
export const Err = {
  MISSING_CONFIG: "MISSING_CONFIG",     // Telegram config not found
  VALIDATION_FAILED: "VALIDATION_FAILED",   // Channel or bot token validation failed
  TELEGRAM_API_ERROR: "TELEGRAM_API_ERROR", // Telegram API returned an error
  NO_MEDIA_SOURCE: "NO_MEDIA_SOURCE",      // No downloadable media found
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",      // Video download failed
  DOWNLOAD_ERROR: "DOWNLOAD_ERROR",        // Generic download error
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT", // Video format not supported
  UPLOAD_TIMEOUT: "UPLOAD_TIMEOUT",        // Telegram upload timed out
  CANCELLED: "CANCELLED",                 // Task cancelled by user
  JOB_NOT_FOUND: "JOB_NOT_FOUND",         // Forward job not found
  UNAUTHORIZED: "UNAUTHORIZED",            // Authentication required
  FORBIDDEN: "FORBIDDEN",                 // Insufficient permissions
  UNKNOWN: "UNKNOWN"                       // Unclassified error
};
