# Investigation — v0.1.0 Implementation & Live No-Restart Verification

**Date:** 2026-09-25 (evening)
**Status:** COMPLETE — plugin live in production service, review board running
**Repo:** https://github.com/hareeshkar/opencode-advisor (public, 2 commits)

## What shipped

- 9 source modules (engine, pruner, prompts, options, providers, v2, v1, types, index)
- 18/18 tests (pruner + engine), tsc strict clean, 35KB zero-dep single-file bundle
- Dual-export entrypoint (V2 `setup()` + V1 `server()`)

## Live install (no OpenCode restart — constraint honored throughout)

Empirically verified host behaviors on v2.0.16, in order:

1. **Flat file → `plugins/`** auto-loads via hot-watch (`watcher subscribe type=file`)
   immediately, but receives NO options → our loud config error surfaced as
   `WARN "failed to load plugin" plugin.id=opencode-advisor cause=…no advisor model configured…`.
   **The silent-failure defense worked as designed: host unharmed, error visible.**
2. **Config `plugins[].package` must be a directory** — flat-file entries log
   `configured plugin path must be a directory` (WARN ×N).
3. **Working layout:** `~/.config/opencode/opencode-advisor/index.js` +
   `"package": "./opencode-advisor"` in opencode.json → loads clean, config
   hot-reload re-fires on every opencode.json write.
4. **Tool catalog refresh:** after registration, Code Mode exposed `tools.advisor()`
   with our exact tool description — runtime proof the transform landed.

## Advisor E2E (three attempts, all through the live service)

| Attempt | Advisor model | Result | Error path exercised |
|---|---|---|---|
| 1 | bailian-token-plan/deepseek-v4-pro | `unavailable` — "Access to model denied" | provider entitlement denial |
| 2 | opencode/glm-5.3 | `unavailable` — "Insufficient account funds" | upstream auth/funds |
| 3 | **zai-coding-plan/glm-5.3** | **✅ real advice, word-capped** | success path |

Attempt-3 advice was contextually correct AND caught a real defect: the pushed
README documented the flat-file install our own logs had just disproved.
Fixed, committed, pushed (`2d06f4b`) — **dogfooding closed the loop**.

## Ledger (durable, plugin-scoped storage)

Key: `plugin:<utf16hex("opencode-advisor")>:usage:2026-09-25`

```json
{"date":"2026-09-25","calls":1,"errors":2,"estTokensIn":12557,"estTokensOut":210,"adviceChars":838}
```

**Token-efficiency proof:** 12,557 est tokens IN for a long session (pruner
working), 210 tokens OUT (word budget working), 2 errors correctly accounted.

## Environment facts added

- Plugin storage keys: `plugin:<utf16hex(plugin-id)>:<key>` in the `kv` table
- User's entitled advisor: `zai-coding-plan/glm-5.3` (per user directive;
  opencode-go pro models explicitly excluded)
- Model catalog endpoint `GET /api/model` returns ~300KB (16 providers, 90+ models)

## In flight

- 3 review subagents (opencode-go/deepseek-v4.1-flash): quality-correctness,
  efficiency, edge-cases → outputs to `reviews/*.md`
