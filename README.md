# opencode-advisor

**Model-agnostic advisor orchestration for [OpenCode](https://opencode.ai) — any executor model escalates to any advisor model, mid-task, with strict token budgets and zero transcript pollution.**

Replicates the efficiency of server-side advisor orchestration (as pioneered by Anthropic's `advisor_20260301` tool) without the vendor lock-in: pair DeepSeek Flash with GLM, Haiku with Opus, Llama with GPT — any combination, through the providers you already have configured.

```
executor hits a decision point ──▶ zero-arg `advisor` tool fires
   │
   ├─ read session transcript (ctx.session.context)
   ├─ prune: strip noise, head+tail-truncate tool output, budget by recency
   ├─ advisor sub-call (ctx.generate.text — no session, no tools, no history)
   └─ advice returns as the tool result ──▶ executor continues, informed
```

- **Native failure semantics** — error codes mirror the Anthropic advisor contract (`max_uses_exceeded`, `too_many_requests`, `overloaded`, `prompt_too_long`, `execution_time_exceeded`, `model_not_found`, `unavailable`); the executor continues gracefully when advice is unavailable.
- **Token-efficient by construction** — advice is word-budgeted (prompt-enforced *and* physically capped), the transcript is pruned to a high-signal excerpt (typical ≤ 0.35 of raw chars), and system injections are transient (never persisted, never inflating compaction).
- **Zero runtime dependencies** — bundles to a single 35KB ESM file. V2 routes through your existing provider registry (no extra credentials); V1 ships direct Anthropic/OpenAI-compatible clients.
- **Defensive engineering** — startup self-probe with loud status, fail-safe hook bodies, per-task call caps, prompt-injection framing, deterministic pruner.

## Install

### OpenCode V2 (verified path)

```sh
git clone https://github.com/hareeshkar/opencode-advisor
cd opencode-advisor && npm run build
cp dist/opencode-advisor.js ~/.config/opencode/plugins/opencode-advisor.js
```

The plugins directory is hot-watched — **no restart required**. Then set the advisor model:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/opencode-advisor.js",
      "options": {
        "advisor": { "providerID": "bailian-token-plan", "id": "deepseek-v4-pro" }
      }
    }
  ]
}
```

Or without config: `export ADVISOR_PROVIDER=bailian-token-plan ADVISOR_MODEL=deepseek-v4-pro`

Verify: `grep -i advisor ~/.local/share/opencode/log/opencode.log | tail` → expect `ready v0.1.0 — tool=✓ advisor=…`

### OpenCode V1 ≥ 1.18.29 (experimental)

Same bundle; the dual-export entrypoint answers `server()` automatically. V1 has no transient-generation primitive, so configure a direct advisor endpoint:

```jsonc
"plugin": [["./plugins/opencode-advisor.js", {
  "advisor": { "providerID": "x", "id": "y" },
  "source": { "kind": "openai-compatible", "baseURL": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "model": "deepseek-chat" }
}]]
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `advisor` | **required** | `{ providerID, id, variant? }` — any model in your OpenCode catalog |
| `maxUsesPerTask` | `3` | Per-task advisor call cap (matches Anthropic's published evals) |
| `adviceWordBudget` | `120` | Target/max advice length in words — prompt-enforced and hard-capped |
| `timeoutMs` | `90000` | Advisor sub-call timeout |
| `prune.maxToolOutputChars` | `1500` | Per-tool-output truncation budget (head 45% + tail 25%) |
| `prune.transcriptBudgetChars` | `48000` | Total transcript budget sent to the advisor |
| `nudge` | `"auto"` | Under-calling nudge for small-tier executors only (frontier-tier excluded — measured negative there) |
| `injectTimingPrompt` | `true` | One-shot executor guidance per task (transient system injection) |
| `logLevel` | `"info"` | `debug` \| `info` \| `warn` \| `error` |

Env overrides (lowest precedence): `ADVISOR_PROVIDER`, `ADVISOR_MODEL`, `ADVISOR_VARIANT`, `ADVISOR_MAX_USES`, `ADVISOR_LOG`, `ADVISOR_SOURCE_KIND/URL/KEY_ENV/MODEL`.

## How it stays cheap

1. **Asymmetric token spend** — the executor (cheap, fast) does all file edits and mechanical work; the advisor (expensive, high-judgment) only emits ≤120-word strategic corrections. Anthropic's published guidance for this pattern reports 35–45% advisor-output reduction from the word-budget instruction alone.
2. **Pruning, not forwarding** — tool outputs are head+tail truncated (commands at the head, errors at the tail), noise (npm/deprecation/progress output) dropped entirely, recency-weighted budget with the original task pinned.
3. **Transient injections** — timing/nudge system text exists for one model call only; it never persists to history or compaction.
4. **Caps everywhere** — per-task call cap, sub-call timeout, physical output cap, transcript budget.

## Design decisions & prior art

The full engineering dossier lives in [`research/`](research/) — notably:

- [`research/phase-a-advisor-api.md`](research/phase-a-advisor-api.md) — native Anthropic advisor mechanics + the LiteLLM client-side emulation this design follows
- [`research/phase-b-opencode-lifecycle.md`](research/phase-b-opencode-lifecycle.md) — V1↔V2 hook crosswalk
- [`research/github-issues-bugs.md`](research/github-issues-bugs.md) — real-world failure modes this plugin defends against (silent hook failures, no mid-flight model switching, etc.)
- [`research/api-types/API_SURFACE_REFERENCE.md`](research/api-types/API_SURFACE_REFERENCE.md) — exact SDK type surface (V2 `@opencode/plugin@2.0.16`)

Key constraint discovered during research: `ctx.generate.text` accepts only `prompt` + model ref — no per-call options — so the output budget is prompt-enforced and physically capped client-side.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit (strict)
npm test            # node --test (pruner + engine suites; 18 tests)
npm run build       # esbuild → dist/opencode-advisor.js (single file, 35KB)
```

## License

[MIT](LICENSE) © 2026 hareeshkar
