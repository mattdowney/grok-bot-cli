import { appendFileSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function failureLogPath() {
  const raw = (process.env.GROK_BOT_FAILURE_LOG || "").trim();
  if (/^(off|false|0)$/i.test(raw)) return null;
  return raw ? resolve(raw) : join(homedir(), ".grok-bot-cli", "gateway-failures.jsonl");
}

// Fixed fields only, never a URL, header, token or response body.
export function logGatewayFailure({ method, status, code, attempt, retrying, elapsedMs }) {
  const path = failureLogPath();
  if (!path) return;
  const row = {
    time: new Date().toISOString(),
    method: String(method),
    status: Number.isInteger(status) ? status : null,
    ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}),
    attempt,
    retrying: Boolean(retrying),
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      appendFileSync(fd, JSON.stringify(row) + "\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    // The log is a diagnostic; a full disk must not turn a call into a failure.
  }
}
