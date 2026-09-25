#!/usr/bin/env bash
# Install the bundled plugin into the user's live OpenCode V2 config.
# Safe on a running instance: ~/.config/opencode/plugins/ is hot-watched.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build --silent
DEST="${HOME}/.config/opencode/plugins/opencode-advisor.js"
cp dist/opencode-advisor.js "$DEST"
cat <<EOF
installed -> $DEST
The plugins directory is hot-watched — no restart needed.

Configure the advisor model (any of):
  1) env:            export ADVISOR_PROVIDER=bailian-token-plan ADVISOR_MODEL=deepseek-v4-pro
  2) opencode.json:  "plugins": [{ "package": "./plugins/opencode-advisor.js",
                      "options": { "advisor": { "providerID": "...", "id": "..." } } }]

Verify:
  grep -i advisor ~/.local/share/opencode/log/opencode.log | tail
  (expect: "ready v0.1.0 — tool=✓ advisor=<provider/model>")
EOF
