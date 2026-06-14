/** Server-side setup secret from SECRET env var. Empty means no setup protection. */
import crypto from "node:crypto";

import { AppError, Err } from "./errors.js";
import { readKeyStore, writeKeyStore } from "./store.js";

export const SERVER_SECRET = String(process.env.SECRET || process.env.BACKEND_SECRET || "").trim();

/** Extract Bearer token from the Authorization header. */
export function getBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/** Verify the request carries the setup secret. Throws if SECRET is set and mismatched. */
export function requireSetupSecret(req) {
  if (!SERVER_SECRET) {
    return;
  }

  if (getBearerToken(req) !== SERVER_SECRET) {
    throw new AppError(Err.UNAUTHORIZED, "Invalid setup secret.");
  }
}

/** Create a new endpoint user with a random API key persisted to disk. Returns { uid, key }. */
export async function createUserKey() {
  const store = await readKeyStore();
  const uid = crypto.randomUUID();
  const key = crypto.randomBytes(32).toString("base64url");
  store.users[uid] = key;
  await writeKeyStore(store);
  return { uid, key };
}

/** Look up a user by Bearer token. Throws if missing or invalid. */
export async function requireUserByBearer(req) {
  const key = getBearerToken(req);
  if (!key) {
    throw new AppError(Err.UNAUTHORIZED, "Missing bearer key.");
  }

  const store = await readKeyStore();
  for (const [uid, storedKey] of Object.entries(store.users)) {
    if (storedKey === key) {
      return { uid, key };
    }
  }

  throw new AppError(Err.UNAUTHORIZED, "Invalid bearer key.");
}
