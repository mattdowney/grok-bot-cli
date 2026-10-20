---
"grok-bot-cli": patch
---

`EnsureSandBox` now sends the installed Grok Bot app's version (from `desktop-status.json`) instead of a fixed `0.20.0`, which Cursor rejects with 401 "This version of Grok Bot is no longer supported". `SAND_CLIENT_VERSION` still wins; the fallback is `0.72.0`.
