import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const writeQueues = new Map();

/** Ensure the data directory exists, creating it if needed. */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Read a JSON file, returning the fallback value if the file is missing or corrupt. */
async function readJsonFile(file, fallback) {
  try {
    const data = await fs.promises.readFile(file, "utf-8");
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

/** Atomically write a JSON value to a file. */
async function writeJsonFile(file, value) {
  let state = writeQueues.get(file);
  if (!state) {
    state = {
      running: false,
      pendingValue: undefined,
      pendingWaiters: []
    };
    writeQueues.set(file, state);
  }

  const result = new Promise((resolve, reject) => {
    state.pendingValue = value;
    state.pendingWaiters.push({ resolve, reject });
  });

  if (!state.running) {
    state.running = true;
    drainJsonFileWrites(file, state);
  }

  return result;
}

async function drainJsonFileWrites(file, state) {
  while (state.pendingWaiters.length) {
    const value = state.pendingValue;
    const waiters = state.pendingWaiters;
    state.pendingValue = undefined;
    state.pendingWaiters = [];

    try {
      await writeJsonFileNow(file, value);
      waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      waiters.forEach(({ reject }) => reject(error));
    }
  }

  state.running = false;
  if (writeQueues.get(file) === state) {
    writeQueues.delete(file);
  }
}

async function writeJsonFileNow(file, value) {
  ensureDataDir();
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${file}.${suffix}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const KEY_FILE = path.join(DATA_DIR, "keys.json");

/** Read the API key store from disk. */
export async function readKeyStore() {
  return readJsonFile(KEY_FILE, { users: {} });
}

/** Persist the API key store to disk. */
export async function writeKeyStore(store) {
  await writeJsonFile(KEY_FILE, store);
}

const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

/** Read persisted forward jobs from disk. */
export async function readPersistedJobs() {
  const data = await readJsonFile(JOBS_FILE, []);
  return Array.isArray(data) ? data : (Array.isArray(data?.jobs) ? data.jobs : []);
}

/** Persist forward jobs to disk. */
export async function writePersistedJobs(jobs) {
  await writeJsonFile(JOBS_FILE, jobs);
}
