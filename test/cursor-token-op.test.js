import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { connectGateway, listAgents } from "../src/core/gateway.js";

const skip = process.platform === "win32" && "fake op is a shebang script";
const OP_TOKEN = "cursor-token-from-op";
let refSeq = 0;

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const prev = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    });
  }
}

// A fake `op` on PATH: counts calls and prints the token, or fails like a signed-out op.
function fakeOp({ fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gbot-fake-op-"));
  const calls = join(dir, "calls");
  writeFileSync(join(dir, "op"), `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${fail}) { process.stderr.write("[ERROR] You are not currently signed in.\\n"); process.exit(1); }
process.stdout.write(${JSON.stringify(OP_TOKEN)} + "\\n");
`);
  chmodSync(join(dir, "op"), 0o755);
  return {
    dir,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
  };
}

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

async function setup(t, { backendStatus = 200, gatewayStatuses = [200], opFails = false } = {}) {
  const op = fakeOp({ fail: opFails });
  const gatewayHits = [];
  const gatewayUrl = await listen(t, async (req, res) => {
    for await (const _ of req);
    gatewayHits.push(req.headers.authorization);
    const status = gatewayStatuses.length > 1 ? gatewayStatuses.shift() : gatewayStatuses[0];
    res.statusCode = status;
    res.end(status === 200 ? JSON.stringify({ agents: [{ id: "b1", name: "Shader" }] }) : "");
  });
  const backendAuth = [];
  const backendUrl = await listen(t, async (req, res) => {
    for await (const _ of req);
    backendAuth.push(req.headers.authorization);
    res.statusCode = backendStatus;
    res.setHeader("content-type", "application/json");
    res.end(backendStatus === 200 ? JSON.stringify({ gatewayUrl, gatewayToken: "gw-" + backendAuth.length }) : JSON.stringify({ message: "unauthenticated" }));
  });
  const ref = `op://Claude/Cursor access token ${++refSeq}/credential`;
  setEnv(t, {
    HOME: mkdtempSync(join(tmpdir(), "gbot-op-home-")),
    XDG_CONFIG_HOME: null,
    APPDATA: null,
    PATH: op.dir + delimiter + process.env.PATH,
    CURSOR_ACCESS_TOKEN: null,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_CURSOR_TOKEN_OP: ref,
    CURSOR_API_BASE_URL: backendUrl,
    GROK_BOT_GATEWAY_RETRY_MS: "60000",
  });
  return { op, ref, gatewayHits, backendAuth };
}

test("with no app login, connect reads the Cursor token from 1Password once and asks EnsureSandBox", { skip }, async (t) => {
  const { op, ref, backendAuth } = await setup(t);
  const session = await connectGateway();
  await connectGateway();
  assert.equal(session.gatewayToken, "gw-1");
  assert.deepEqual(op.calls(), [["read", ref]], "op runs once; the token is cached in memory");
  assert.deepEqual(backendAuth, ["Bearer " + OP_TOKEN, "Bearer " + OP_TOKEN]);
});

test("a sleeping box is woken through EnsureSandBox with the 1Password token before the retry", { skip }, async (t) => {
  const { gatewayHits, backendAuth } = await setup(t, { gatewayStatuses: [417, 200] });
  const session = await connectGateway();
  const agents = await listAgents(session);
  assert.equal(agents[0].name, "Shader");
  assert.equal(backendAuth.length, 2, "one EnsureSandBox to connect, one to wake");
  assert.deepEqual(gatewayHits, ["Bearer gw-1", "Bearer gw-2"]);
});

test("a 401 from Cursor says the token expired and how to refresh it, without the token", { skip }, async (t) => {
  await setup(t, { backendStatus: 401 });
  await assert.rejects(connectGateway(), (e) => {
    assert.equal(e.message, "Cursor token expired: rerun ~/Desktop/save-cursor-token.sh");
    assert.equal(e.status, 401);
    return true;
  });
});

test("an expired token during a wake stops the retries at once", { skip }, async (t) => {
  const ctx = await setup(t, { gatewayStatuses: [417] });
  const session = await connectGateway();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("EnsureSandBox")) return new Response(JSON.stringify({ message: "denied" }), { status: 403 });
    ctx.gatewayHits.push(init.headers.authorization);
    return new Response("", { status: 417 });
  });
  const started = Date.now();
  await assert.rejects(listAgents(session), (e) => {
    assert.match(e.message, /^listAgents failed: the bots' cloud computer is asleep \(417\)\. Could not wake the box: Cursor token expired: rerun ~\/Desktop\/save-cursor-token\.sh$/);
    assert.doesNotMatch(e.message, new RegExp(OP_TOKEN));
    return true;
  });
  assert.ok(Date.now() - started < 10000, "did not wait out the retry window");
});

test("a failing op read names 1Password and the reason, never a token", { skip }, async (t) => {
  const { ref } = await setup(t, { opFails: true });
  await assert.rejects(connectGateway(), (e) => {
    assert.equal(e.message, `Could not read the Cursor token from 1Password (op read ${ref}: [ERROR] You are not currently signed in.).`);
    return true;
  });
});

test("GROK_BOT_CURSOR_TOKEN_OP must be an op:// reference", { skip }, async (t) => {
  const { op } = await setup(t);
  process.env.GROK_BOT_CURSOR_TOKEN_OP = "not-a-reference";
  await assert.rejects(connectGateway(), /must be an op:\/\/vault\/item\/field reference/);
  assert.deepEqual(op.calls(), [], "op is not run for a bad reference");
});

test("a 401 for an unsupported client version is not reported as an expired token", { skip }, async (t) => {
  await setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: "unauthenticated", message: "This version of Grok Bot is no longer supported. Update Grok Bot from cursor.com/sand to continue." }), { status: 401 }));
  await assert.rejects(connectGateway(), (e) => {
    assert.match(e.message, /^Cursor refused gbot's client version [\d.]+: This version of Grok Bot is no longer supported\./);
    assert.match(e.message, /SAND_CLIENT_VERSION/);
    assert.doesNotMatch(e.message, /expired/);
    return true;
  });
});
