import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cursorStatePath, daysUntil, hasCursorLogin, jwtExpiryMs, readCursorAccessToken } from "../src/core/cursor-login.js";

// A real SQLite file shaped like Cursor's state.vscdb, used as the fake login store.
function writeCursorDb(entries) {
  const home = mkdtempSync(join(tmpdir(), "gbot-cursor-home-"));
  const path = cursorStatePath({ home, platform: "darwin" });
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("create table ItemTable (key text primary key, value blob)");
  const insert = db.prepare("insert into ItemTable (key, value) values (?, ?)");
  for (const [key, value] of Object.entries(entries)) insert.run(key, value);
  db.close();
  return { home, path };
}

function fakeJwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.sig`;
}

test("reads Cursor's current access token from its database", () => {
  const token = fakeJwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 3600 });
  const { home } = writeCursorDb({ "cursorAuth/accessToken": token, "cursorAuth/refreshToken": "refresh-value" });
  assert.equal(readCursorAccessToken({ home, platform: "darwin" }), token);
});

test("returns null when Cursor is not installed or signed out", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "gbot-cursor-none-")), "nope");
  assert.equal(hasCursorLogin({ home: missing, platform: "darwin" }), false);
  assert.equal(readCursorAccessToken({ home: missing, platform: "darwin" }), null);
  const { home } = writeCursorDb({ "cursorAuth/refreshToken": "r" });
  assert.equal(readCursorAccessToken({ home, platform: "darwin" }), null);
});

test("reads with no write: the database is opened read-only", () => {
  const { home, path } = writeCursorDb({ "cursorAuth/accessToken": "tok" });
  readCursorAccessToken({ home, platform: "darwin" });
  const db = new DatabaseSync(path, { readOnly: true });
  const count = db.prepare("select count(*) as n from ItemTable").get().n;
  db.close();
  assert.equal(count, 1, "nothing was added or changed");
});

test("a failing open is reported without a token", () => {
  const openDb = () => { throw new Error("database is locked"); };
  assert.throws(() => readCursorAccessToken({ openDb, home: "/x", platform: "darwin" }), /Could not open Cursor's login database \(database is locked\)/);
});

test("jwtExpiryMs reads the exp claim; daysUntil floors to whole days", () => {
  const exp = Math.floor(Date.UTC(2026, 11, 12) / 1000);
  assert.equal(jwtExpiryMs(fakeJwt({ exp })), exp * 1000);
  assert.equal(jwtExpiryMs("not-a-jwt"), null);
  assert.equal(jwtExpiryMs(fakeJwt({ sub: "u" })), null);
  assert.equal(daysUntil(exp * 1000, Date.UTC(2026, 11, 2)), 10);
  assert.equal(daysUntil(null), null);
});

test("the state path follows the platform", () => {
  assert.match(cursorStatePath({ home: "/Users/x", platform: "darwin" }), /Library\/Application Support\/Cursor\/User\/globalStorage\/state\.vscdb$/);
  assert.match(cursorStatePath({ home: "/home/x", platform: "linux", env: {} }), /\.config\/Cursor\/User\/globalStorage\/state\.vscdb$/);
  assert.match(cursorStatePath({ home: "C:\\Users\\x", platform: "win32", env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" } }), /Cursor[\\/]User[\\/]globalStorage[\\/]state\.vscdb$/);
});
