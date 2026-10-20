import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));

async function gatewayAnswering(t, status) {
  const hits = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    hits.push(req.url);
    res.statusCode = status;
    res.end(status === 200 ? JSON.stringify({ agents: [{ id: "b1", name: "Shader" }, { id: "g1", name: "Team", isGroup: true, memberIds: ["b1"] }] }) : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: "http://127.0.0.1:" + server.address().port, hits };
}

async function runHealth(url, extraEnv = {}) {
  const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "gbot-health-home-")), GROK_BOT_TEST: "1", GROK_BOT_GATEWAY_URL: url, GROK_BOT_GATEWAY_TOKEN: "secret-token", GROK_BOT_GATEWAY_RETRY_MS: "60000", ...extraEnv };
  delete env.CURSOR_ACCESS_TOKEN;
  const child = spawn(process.execPath, [CLI, "health", "--json"], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

test("health exits 0 and counts bots after one live read", async (t) => {
  const gw = await gatewayAnswering(t, 200);
  const result = await runHealth(gw.url);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.bots, 1);
  assert.equal(payload.groups, 1);
  assert.deepEqual(gw.hits, ["/api/listAgents"]);
});

test("health exits 1 with the reason on a sleeping box, without retrying, and logs it", async (t) => {
  const gw = await gatewayAnswering(t, 417);
  const log = join(mkdtempSync(join(tmpdir(), "gbot-health-log-")), "failures.jsonl");
  const result = await runHealth(gw.url, { GROK_BOT_FAILURE_LOG: log });
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 417);
  assert.equal(payload.reason, "the bots' cloud computer is asleep (417)");
  assert.match(payload.hint, /Grok Bot app/);
  assert.deepEqual(gw.hits, ["/api/listAgents"], "one call, no retry");
  assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);
  assert.equal(JSON.parse(readFileSync(log, "utf8")).status, 417);
});
