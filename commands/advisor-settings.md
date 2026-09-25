---
description: Choose the advisor model and variant via a guided question flow
---

Help me choose the advisor model in two steps:

1. Read the configured providers from the opencode.json file containing the opencode-advisor plugin entry (usually ~/.config/opencode/opencode.json) and ask me which advisor model I want via the question tool, offering the configured models as options (current first, marked Recommended). Focus: $ARGUMENTS
2. Then ask which variant/thinking effort I want (or "default"/none).
3. Write my choice into the "advisor" option of the opencode-advisor plugin entry as { "providerID": "...", "id": "..." } plus "variant" only if I chose one. Edit ONLY that field — read the file first, preserve every other key, and re-read to verify.
4. Confirm the switch as provider/model[#variant] and note it applies from the next consultation (config hot-reloads).
