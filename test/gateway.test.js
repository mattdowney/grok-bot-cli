import test from "node:test";
import assert from "node:assert/strict";
import {
  headersFromEnsureSandbox,
  mergeGatewayHeaders,
  parseGatewayHeaders,
  requestHeaders,
} from "../src/core/headers.js";

test("parses env JSON headers", () => {
  const headers = parseGatewayHeaders('{"X-Anyrun-Network-Token":"abc","empty":""}');
  assert.deepEqual(headers, { "x-anyrun-network-token": "abc" });
});

test("reads EnsureSandBox gatewayHeaders", () => {
  const headers = headersFromEnsureSandbox({
    gatewayHeaders: { "X-Anyrun-Network-Token": "from-ensure" },
  });
  assert.equal(headers["x-anyrun-network-token"], "from-ensure");
});

test("reads EnsureSandBox token field", () => {
  const headers = headersFromEnsureSandbox({ anyrunNetworkToken: "field-token" });
  assert.equal(headers["x-anyrun-network-token"], "field-token");
});

test("env headers override EnsureSandBox", () => {
  const headers = mergeGatewayHeaders(
    { "x-anyrun-network-token": "ensure" },
    { "x-anyrun-network-token": "env" },
  );
  assert.equal(headers["x-anyrun-network-token"], "env");
});

test("request headers keep routing header", () => {
  const headers = requestHeaders({
    gatewayToken: "gw",
    gatewayHeaders: { "x-anyrun-network-token": "route" },
  });
  assert.equal(headers["x-anyrun-network-token"], "route");
  assert.match(headers.authorization, /^Bearer /);
});

test("empty env JSON is a no-op", () => {
  assert.deepEqual(parseGatewayHeaders(""), {});
  assert.deepEqual(parseGatewayHeaders(undefined), {});
});

test("EnsureSandBox reports the installed Grok Bot app's version, unless SAND_CLIENT_VERSION is set", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureSandboxHeaders } = await import("../src/core/headers.js");
  const { grokBotAppVersion } = await import("../src/core/app-session.js");
  const home = mkdtempSync(join(tmpdir(), "gbot-version-home-"));
  const dir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "desktop-status.json"), JSON.stringify({ version: 1, appVersion: "0.99.1", signedIn: true }));
  assert.equal(grokBotAppVersion({ home, platform: "darwin" }), "0.99.1");
  writeFileSync(join(dir, "desktop-status.json"), JSON.stringify({ appVersion: "not a version" }));
  assert.equal(grokBotAppVersion({ home, platform: "darwin" }), null);
  assert.equal(grokBotAppVersion({ home: join(home, "missing"), platform: "darwin" }), null);

  const prevHome = process.env.HOME;
  const prevVersion = process.env.SAND_CLIENT_VERSION;
  t.after(() => {
    process.env.HOME = prevHome;
    if (prevVersion === undefined) delete process.env.SAND_CLIENT_VERSION;
    else process.env.SAND_CLIENT_VERSION = prevVersion;
  });
  delete process.env.SAND_CLIENT_VERSION;
  process.env.HOME = join(home, "missing");
  assert.equal(ensureSandboxHeaders("t")["x-cursor-client-version"], "0.72.0");
  process.env.SAND_CLIENT_VERSION = "1.2.3";
  assert.equal(ensureSandboxHeaders("t")["x-cursor-client-version"], "1.2.3");
});
