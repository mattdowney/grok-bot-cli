---
"grok-bot-cli": minor
---

Add `gbot health`: one live `listAgents` call with no retry and no wake. It exits `0` with the bot and group counts, or `1` with the reason (for example, the box is asleep) and what to do next.
