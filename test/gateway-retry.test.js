import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyGatewayFailure, connectGateway, getTranscriptTail, listAgents, sendPrompt } from "../src/core/gateway.js";

const roster = { agents: [{ id: "bot-1", name: "General" }] };

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

// A fake gateway: each path answers from its own queue of [status, body], the last one repeating.
async function fakeGateway(t, script) {
  const received = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push({ url: req.url, body: text ? JSON.parse(text) : {}, auth: req.headers.authorization });
    const queue = script[req.url] ?? [[200, req.url === "/api/listAgents" ? roster : {}]];
    const [status, body] = queue.length > 1 ? queue.shift() : queue[0];
    res.statusCode = status;
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: "http://127.0.0.1:" + server.address().port, received };
}

test("a read retries through a sleeping box: 417, then 200", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "2000" });
  const gw = await fakeGateway(t, { "/api/listAgents": [[417, ""], [200, roster]] });
  const agents = await listAgents({ gatewayUrl: gw.url, gatewayToken: "t" });
  assert.deepEqual(agents.map((a) => a.id), ["bot-1"]);
  assert.equal(gw.received.length, 2);
});

test("sendPrompt is resent after a 417, because the box refused it", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "2000" });
  const gw = await fakeGateway(t, { "/api/sendPrompt": [[417, ""], [200, { messageId: "m-1" }]] });
  const out = await sendPrompt({ gatewayUrl: gw.url, gatewayToken: "t" }, "General", "hi");
  assert.equal(out.delivery, "accepted");
  const sends = gw.received.filter((r) => r.url === "/api/sendPrompt");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].body.clientNonce, sends[1].body.clientNonce, "the resend keeps its idempotency nonce");
});

test("sendPrompt is never resent after a 5xx that may have landed", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "2000" });
  const gw = await fakeGateway(t, { "/api/sendPrompt": [[503, ""], [200, { messageId: "m-1" }]] });
  await assert.rejects(sendPrompt({ gatewayUrl: gw.url, gatewayToken: "t" }, "General", "hi"), (e) => {
    assert.equal(e.delivery, "unknown");
    assert.match(e.message, /check the thread before resending/);
    return true;
  });
  assert.equal(gw.received.filter((r) => r.url === "/api/sendPrompt").length, 1);
});

test("a read retries a 503 and an unroutable 404, but not a plain 404", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "10000" });
  const gw = await fakeGateway(t, {
    "/api/listAgents": [[503, ""], [404, "The request could not be routed"], [200, roster]],
    "/api/getAgentTranscriptTail": [[404, { message: "no such agent" }], [200, { entries: [] }]],
  });
  const session = { gatewayUrl: gw.url, gatewayToken: "t" };
  assert.equal((await listAgents(session)).length, 1);
  assert.equal(gw.received.length, 3);
  await assert.rejects(getTranscriptTail(session, "General"), /getAgentTranscriptTail failed: 404 no such agent/);
  assert.equal(gw.received.filter((r) => r.url === "/api/getAgentTranscriptTail").length, 1);
});

test("giving up says what failed, how long it tried, and what it tried", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "300", CURSOR_ACCESS_TOKEN: null });
  const gw = await fakeGateway(t, { "/api/listAgents": [[417, ""]] });
  await assert.rejects(listAgents({ gatewayUrl: gw.url, gatewayToken: "t" }), (e) => {
    assert.equal(e.status, 417);
    assert.ok(e.attempts >= 2);
    assert.match(e.message, /^listAgents failed: 417 .*Gave up after \d+ attempts over \d+s: the bots' cloud computer is asleep \(417\)\./);
    assert.match(e.message, /cannot wake the box without CURSOR_ACCESS_TOKEN/);
    assert.doesNotMatch(e.message, /127\.0\.0\.1/);
    return true;
  });
});

test("with retries off a sleeping box fails at once and says why", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "0" });
  const gw = await fakeGateway(t, { "/api/listAgents": [[417, ""], [200, roster]] });
  await assert.rejects(listAgents({ gatewayUrl: gw.url, gatewayToken: "t" }), /asleep \(417\); retries are off/);
  assert.equal(gw.received.length, 1);
});

test("with CURSOR_ACCESS_TOKEN a retry wakes the box through EnsureSandBox and uses the fresh login", async (t) => {
  const gw = await fakeGateway(t, { "/api/listAgents": [[417, ""], [200, roster]] });
  const ensureCalls = [];
  const backend = createServer(async (req, res) => {
    for await (const _ of req);
    ensureCalls.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ gatewayUrl: gw.url, gatewayToken: "fresh-token" }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  setEnv(t, {
    HOME: mkdtempSync(join(tmpdir(), "gbot-retry-home-")),
    XDG_CONFIG_HOME: null,
    APPDATA: null,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_GATEWAY_RETRY_MS: "2000",
    CURSOR_ACCESS_TOKEN: "cursor-token",
    CURSOR_API_BASE_URL: "http://127.0.0.1:" + backend.address().port,
  });

  const session = await connectGateway();
  assert.equal(ensureCalls.length, 1);
  session.gatewayToken = "stale-token";
  await listAgents(session);
  assert.deepEqual(ensureCalls, ["/aiserver.v1.GrokBotService/EnsureSandBox", "/aiserver.v1.GrokBotService/EnsureSandBox"]);
  assert.deepEqual(gw.received.map((r) => r.auth), ["Bearer stale-token", "Bearer fresh-token"]);
});

test("cancelling stops the retry wait", async (t) => {
  setEnv(t, { GROK_BOT_GATEWAY_RETRY_MS: "60000" });
  const gw = await fakeGateway(t, { "/api/listAgents": [[417, ""]] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(listAgents({ gatewayUrl: gw.url, gatewayToken: "t" }, { signal: controller.signal }), /cancelled/);
  assert.ok(Date.now() - started < 5000);
});

test("classifies network errors by whether the request could have left", () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  const timeout = new DOMException("timed out", "TimeoutError");
  assert.equal(classifyGatewayFailure(refused).delivered, false);
  assert.equal(classifyGatewayFailure(reset).delivered, "maybe");
  assert.equal(classifyGatewayFailure(timeout).delivered, "maybe");
  assert.equal(classifyGatewayFailure({ reason: "cancelled" }).delivered, null);
});
