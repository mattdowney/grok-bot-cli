---
"grok-bot-cli": minor
---

Retry gateway calls for up to 5 minutes when the box is asleep (`417`), unroutable (`404`), unavailable (`502`/`503`/`504`) or unreachable. Each retry first wakes the box through `EnsureSandBox` when `CURSOR_ACCESS_TOKEN` is set, or re-reads the Grok Bot app session. `sendPrompt` and other writes are resent only when the box surely never saw them. `GROK_BOT_GATEWAY_RETRY_MS` sets the window; `0` turns retries off.
