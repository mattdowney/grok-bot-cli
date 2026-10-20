---
"grok-bot-cli": minor
---

Read Cursor's own signed-in access token live from its `state.vscdb` (read-only, never written) as the last token source, after `CURSOR_ACCESS_TOKEN` and the 1Password override. gbot does not renew the token, so it cannot sign Cursor out; Cursor keeps it fresh. An expired token, or a 401/403 from Cursor, fails with "Cursor token expired. Open Cursor once to sign in again." `gbot health` names the login source and the days left on a Cursor token, warning under seven days. `GROK_BOT_NO_CURSOR_LOGIN=1` opts out.
