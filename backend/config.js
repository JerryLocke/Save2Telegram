import fs from "node:fs";

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;

    const eq = raw.indexOf("=");
    const key = normalizeKey(eq === -1 ? raw.slice(2) : raw.slice(2, eq));
    const value = eq === -1 ? argv[i + 1] : raw.slice(eq + 1);

    if (!key || value === undefined || String(value).startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = value;
    if (eq === -1) i += 1;
  }

  return args;
}

function normalizeKey(key) {
  return String(key || "").trim().replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

const args = parseArgs(process.argv.slice(2));
const DEFAULT_EXTENSION_ID = "hibaajhphchibdfkciepacbnifbeiikc";
const packageJson = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export const PORT = Number(args.port || process.env.PORT || 3000);
export const HOST = String(args.host || process.env.HOST || "0.0.0.0");
export const PUBLIC_URL = String(args.publicUrl || "");
export const EXTENSION_ID = String(args.extensionId || DEFAULT_EXTENSION_ID).trim();
export const SERVER_SECRET = String(args.secret || "").trim();
export const APP_NAME = String(args.appName || "Save2Telegram").trim() || "Save2Telegram";
export const BACKEND_VERSION = String(packageJson.version || "0.0.0");
