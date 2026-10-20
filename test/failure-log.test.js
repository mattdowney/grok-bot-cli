import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failureLogPath } from "../src/core/failure-log.js";
import { listAgents } from "../src/core/gateway.js";

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

async function gatewayAnswering(t, statuses) {
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    res.statusCode = status;
    res.end(status === 200 ? JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }) : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

test("each failed attempt is one JSONL row with no token, header or URL", async (t) => {
  const log = join(mkdtempSync(join(tmpdir(), "gbot-faillog-")), "nested", "failures.jsonl");
  setEnv(t, { GROK_BOT_FAILURE_LOG: log, GROK_BOT_GATEWAY_RETRY_MS: "5000" });
  const url = await gatewayAnswering(t, [417, 503, 200]);

  await listAgents({ gatewayUrl: url, gatewayToken: "secret-gateway-token", gatewayHeaders: { "x-anyrun-network-token": "secret-route" } });

  const text = readFileSync(log, "utf8");
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map(({ method, status, attempt, retrying }) => ({ method, status, attempt, retrying })), [
    { method: "listAgents", status: 417, attempt: 1, retrying: true },
    { method: "listAgents", status: 503, attempt: 2, retrying: true },
  ]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["attempt", "elapsedMs", "method", "retrying", "status", "time"]);
    assert.ok(!Number.isNaN(Date.parse(row.time)));
  }
  assert.doesNotMatch(text, /secret|127\.0\.0\.1|http/);
});

test("a final failure is logged with retrying false", async (t) => {
  const log = join(mkdtempSync(join(tmpdir(), "gbot-faillog-")), "failures.jsonl");
  setEnv(t, { GROK_BOT_FAILURE_LOG: log, GROK_BOT_GATEWAY_RETRY_MS: "0" });
  const url = await gatewayAnswering(t, [417]);

  await assert.rejects(listAgents({ gatewayUrl: url, gatewayToken: "t" }));

  const rows = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].retrying, false);
});

test("network failures log their error code", async (t) => {
  const log = join(mkdtempSync(join(tmpdir(), "gbot-faillog-")), "failures.jsonl");
  setEnv(t, { GROK_BOT_FAILURE_LOG: log, GROK_BOT_GATEWAY_RETRY_MS: "0" });
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  });

  await assert.rejects(listAgents({ gatewayUrl: "http://127.0.0.1:1", gatewayToken: "t" }));

  const row = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(row.status, null);
  assert.equal(row.code, "ECONNREFUSED");
});

test("off turns the log off; the default lives under ~/.grok-bot-cli", (t) => {
  const home = mkdtempSync(join(tmpdir(), "gbot-faillog-home-"));
  setEnv(t, { GROK_BOT_FAILURE_LOG: "off", HOME: home });
  assert.equal(failureLogPath(), null);
  process.env.GROK_BOT_FAILURE_LOG = "";
  assert.equal(failureLogPath(), join(home, ".grok-bot-cli", "gateway-failures.jsonl"));
  assert.equal(existsSync(join(home, ".grok-bot-cli")), false, "resolving the path writes nothing");
});
