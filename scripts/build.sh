#!/usr/bin/env bash
# Bundle to a single zero-dependency ESM file for copy-into-place install.
# zod is a V1-host runtime concern and stays external (dynamic import).
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
echo "bundled -> dist/opencode-advisor.js ($(wc -c < dist/opencode-advisor.js | tr -d ' ') bytes)"
