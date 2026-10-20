---
"grok-bot-cli": minor
---

Read the Cursor access token from 1Password when `GROK_BOT_CURSOR_TOKEN_OP` names an `op://` reference and `CURSOR_ACCESS_TOKEN` is unset. gbot runs `op read` only when it needs the token, keeps it in memory, and uses it to wake a sleeping box through `EnsureSandBox` and to connect when there is no app login. A `401`/`403` from Cursor fails at once with a refresh hint. App logins older than 7 days now count as expired, matching the app.
