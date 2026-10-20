---
"grok-bot-cli": patch
---

Read Grok Bot app gateway descriptors at version 3 and gateways nested under `connection`. When several gateways are saved, use the newest `savedAtMs`. Unknown formats now fail with the version and field names seen, never the values.
