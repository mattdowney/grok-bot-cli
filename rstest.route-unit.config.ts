import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

// Loopback-only credential URLs (src/core/url-policy.js testMode); workers inherit the env.
process.env.GROK_BOT_TEST = '1';
// A mocked outage fails fast instead of waiting out the 5 minute gateway retry window.
process.env.GROK_BOT_GATEWAY_RETRY_MS ??= '0';
process.env.GROK_BOT_FAILURE_LOG ??= 'off';
delete process.env.GROK_BOT_CURSOR_TOKEN_OP;
process.env.GROK_BOT_NO_CURSOR_LOGIN = '1';

export default defineConfig(await agentBundleRstest());
