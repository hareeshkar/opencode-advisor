#!/usr/bin/env bash
# Install the bundled plugin into the user's live OpenCode V2 config.
# Safe on a running instance: plugin directories are hot-watched.
#
# Layout note (verified against v2.0.16): config plugins[].package entries
# must reference a DIRECTORY. A flat file logs
# "configured plugin path must be a directory" and receives no options.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build --silent
SRC="dist/opencode-advisor.js"
DIR="${HOME}/.config/opencode/opencode-advisor"
mkdir -p "$DIR"
cp "$SRC" "$DIR/index.js"
cp dist/tui.js "$DIR/tui.js"
cat <<EOF
installed -> $DIR/index.js
The plugin directory is hot-watched — no restart needed.

Wire it up in ~/.config/opencode/opencode.json:

  "plugins": [{
    "package": "./opencode-advisor",
    "options": { "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3" } }
  }]

Verify:
  grep -i advisor ~/.local/share/opencode/log/opencode.log | tail
EOF
