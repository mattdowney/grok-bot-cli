import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cursorStatePath } from "../src/core/cursor-login.js";
import { checkGatewayHealth, connectGateway, listAgents } from "../src/core/gateway.js";

const skip = process.platform === "win32" && "paths assume a POSIX Cursor layout";

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const prev = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
  }
}

function fakeJwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.sig`;
}

// A temp HOME holding a Cursor state.vscdb with the given access token.
function cursorHome(token) {
  const home = mkdtempSync(join(tmpdir(), "gbot-live-home-"));
  const path = cursorStatePath({ home, platform: process.platform, env: { XDG_CONFIG_HOME: join(home, ".config") } });
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("create table ItemTable (key text primary key, value blob)");
  if (token) db.prepare("insert into ItemTable (key, value) values (?, ?)").run("cursorAuth/accessToken", token);
  db.close();
  return home;
}

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

async function withCursor(t, { token, gatewayStatuses = [200], backendStatus = 200 } = {}) {
  const gatewayHits = [];
  const gatewayUrl = await listen(t, async (req, res) => {
    for await (const _ of req);
    gatewayHits.push(req.headers.authorization);
    const status = gatewayStatuses.length > 1 ? gatewayStatuses.shift() : gatewayStatuses[0];
    res.statusCode = status;
    res.end(status === 200 ? JSON.stringify({ agents: [{ id: "b1", name: "Shader" }, { id: "g1", name: "Team", isGroup: true, memberIds: ["b1"] }] }) : "");
  });
  const backendAuth = [];
  const backendUrl = await listen(t, async (req, res) => {
    for await (const _ of req);
    backendAuth.push(req.headers.authorization);
    res.statusCode = backendStatus;
    res.setHeader("content-type", "application/json");
    res.end(backendStatus === 200 ? JSON.stringify({ gatewayUrl, gatewayToken: "gw-" + backendAuth.length }) : JSON.stringify({ message: "nope" }));
  });
  setEnv(t, {
    HOME: cursorHome(token),
    XDG_CONFIG_HOME: null,
    APPDATA: null,
    CURSOR_ACCESS_TOKEN: null,
    GROK_BOT_CURSOR_TOKEN_OP: null,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    CURSOR_API_BASE_URL: backendUrl,
    GROK_BOT_GATEWAY_RETRY_MS: "60000",
    GROK_BOT_NO_CURSOR_LOGIN: null,
  });
  return { gatewayHits, backendAuth };
}

const inHours = (h) => fakeJwt({ exp: Math.floor(Date.now() / 1000) + h * 3600 });

test("with no env or op, connect uses Cursor's live token through EnsureSandBox", { skip }, async (t) => {
  const token = inHours(72);
  const ctx = await withCursor(t, { token });
  const session = await connectGateway();
  assert.equal(session.gatewayToken, "gw-1");
  assert.equal(ctx.backendAuth[0], "Bearer " + token, "Cursor's live token reached EnsureSandBox");
});

test("health names the Cursor source and the days left", { skip }, async (t) => {
  await withCursor(t, { token: inHours(30 * 24) });
  const result = await checkGatewayHealth();
  assert.equal(result.ok, true);
  assert.equal(result.source, "ensure");
  assert.equal(result.tokenSource, "cursor");
  assert.equal(result.daysLeft, 29);
  assert.equal(result.tokenWarning, undefined);
  assert.equal(result.bots, 1);
  assert.equal(result.groups, 1);
});

test("health warns when fewer than seven days remain", { skip }, async (t) => {
  await withCursor(t, { token: inHours(72) });
  const result = await checkGatewayHealth();
  assert.equal(result.daysLeft, 2);
  assert.match(result.tokenWarning, /2 days left; open Cursor to renew it\./);
});

test("an expired Cursor token fails before any request, with the sign-in message", { skip }, async (t) => {
  const ctx = await withCursor(t, { token: inHours(-1) });
  await assert.rejects(connectGateway(), (e) => {
    assert.equal(e.message, "Cursor token expired. Open Cursor once to sign in again.");
    return true;
  });
  assert.equal(ctx.backendAuth.length, 0, "no EnsureSandBox call was made");
});

test("a 401 from Cursor's backend fails with the same sign-in message", { skip }, async (t) => {
  await withCursor(t, { token: inHours(72), backendStatus: 401 });
  const result = await checkGatewayHealth();
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "Cursor token expired. Open Cursor once to sign in again.");
});

test("signed out of Cursor with nothing else set says what to set", { skip }, async (t) => {
  await withCursor(t, { token: null });
  await assert.rejects(connectGateway(), /Set CURSOR_ACCESS_TOKEN or GROK_BOT_CURSOR_TOKEN_OP, sign in to Cursor/);
});

test("CURSOR_ACCESS_TOKEN wins over Cursor's live token", { skip }, async (t) => {
  const ctx = await withCursor(t, { token: inHours(72) });
  const envToken = inHours(100);
  process.env.CURSOR_ACCESS_TOKEN = envToken;
  await connectGateway();
  assert.equal(ctx.backendAuth[0], "Bearer " + envToken, "the env token, not Cursor's, reached EnsureSandBox");
});
