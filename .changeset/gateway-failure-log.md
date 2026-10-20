---
"grok-bot-cli": minor
---

Append each failed gateway attempt to `~/.grok-bot-cli/gateway-failures.jsonl` (time, method, status, network code, attempt, whether it will retry, elapsed time). Rows never hold a URL, header, token or response body. `GROK_BOT_FAILURE_LOG` moves the file or turns it `off`.
