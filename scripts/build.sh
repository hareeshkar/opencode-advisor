#!/usr/bin/env bash
# Bundle to single zero-dependency ESM files for copy-into-place install:
#   dist/opencode-advisor.js — server plugin (index.js)
#   dist/tui.js              — CLI/TUI plugin (tui.js, resolved by filename)
# zod and @opencode/plugin/tui are host-provided and stay external.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
npx esbuild src/index.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node20 \
  --external:zod \
  --legal-comments=none \
  --outfile=dist/opencode-advisor.js
npx esbuild src/tui.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node20 \
  --external:@opencode/plugin/tui \
  --legal-comments=none \
  --outfile=dist/tui.js
echo "bundled -> dist/opencode-advisor.js ($(wc -c < dist/opencode-advisor.js | tr -d ' ') bytes)"
echo "bundled -> dist/tui.js ($(wc -c < dist/tui.js | tr -d ' ') bytes)"
