import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

// Cursor stores its own signed-in access token in this VS Code style key/value database.
// gbot reads it read-only, on each run, and never writes it. The Cursor app renews the
// token itself; gbot only borrows the current value, so it never signs Cursor out.
const CURSOR_AUTH_KEY = "cursorAuth/accessToken";

export function cursorStatePath({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData/Roaming");
    return join(appData, "Cursor/User/globalStorage/state.vscdb");
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
    return join(configHome, "Cursor/User/globalStorage/state.vscdb");
  }
  return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
}

export function hasCursorLogin(options = {}) {
  return existsSync(cursorStatePath(options));
}

/**
 * Read Cursor's current access token from its database, read-only. Returns the token string,
 * or null when Cursor is not installed or signed out. Throws only on an unreadable database.
 * `openDb` is injectable for tests; by default it opens node:sqlite in read-only mode.
 */
export function readCursorAccessToken({ openDb, ...options } = {}) {
  const path = cursorStatePath(options);
  if (!openDb && !existsSync(path)) return null;
  let db;
  try {
    db = openDb ? openDb(path) : openCursorDb(path);
  } catch (error) {
    throw new Error(`Could not open Cursor's login database (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const row = db.prepare(`select value from ItemTable where key = ?`).get(CURSOR_AUTH_KEY);
    const value = row?.value;
    const token = typeof value === "string" ? value : value == null ? "" : String(value);
    return token.trim() || null;
  } finally {
    try { db.close?.(); } catch { /* already closed */ }
  }
}

function openCursorDb(path) {
  // Lazy, so a platform without node:sqlite only fails when a Cursor read is actually needed.
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}

// A JWT exp claim, in ms since epoch, or null when the token is not a readable JWT.
export function jwtExpiryMs(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function daysUntil(expiryMs, now = Date.now()) {
  if (expiryMs == null) return null;
  return Math.floor((expiryMs - now) / (24 * 60 * 60 * 1000));
}
