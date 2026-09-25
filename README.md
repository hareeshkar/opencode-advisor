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

The config `plugins[].package` entry must point at a **directory** (verified against v2.0.16 — a flat file entry logs `configured plugin path must be a directory`):

```sh
git clone https://github.com/hareeshkar/opencode-advisor
cd opencode-advisor && npm run build
mkdir -p ~/.config/opencode/opencode-advisor
cp dist/opencode-advisor.js ~/.config/opencode/opencode-advisor/index.js
```

Plugin directories are hot-watched — **no restart required**. Then configure:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-advisor",
      "options": {
        "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3" }
      }
    }
  ]
}
```

Alternative — flat auto-discovery (drops the file into `~/.config/opencode/plugins/`): it loads with **no options**, so configuration must come from env vars instead:

```sh
cp dist/opencode-advisor.js ~/.config/opencode/plugins/opencode-advisor.js
export ADVISOR_PROVIDER=zai-coding-plan ADVISOR_MODEL=glm-5.3   # must be set before the service starts
```

Verify: `grep -i advisor ~/.local/share/opencode/log/opencode.log | tail` → expect `ready v0.1.0 — tool=✓ advisor=…`. A misconfigured plugin fails **loudly** (`failed to load plugin … cause: …`) and never harms the running host.

### OpenCode V1 ≥ 1.18.29 (experimental)

Same bundle; the dual-export entrypoint answers `server()` automatically. V1 has no transient-generation primitive, so configure a direct advisor endpoint:

```jsonc
"plugin": [["./plugins/opencode-advisor.js", {
  "advisor": { "providerID": "x", "id": "y" },
  "source": { "kind": "openai-compatible", "baseURL": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "model": "deepseek-chat" }
}]]
```

## On-demand consultation: trigger words + `/advisor`

**Design principle: user-gated, credit-conscious.** The executor defaults to
its best solo work and NEVER calls the advisor unprompted — advisor credits
are expensive. Escalation happens only through explicit user intent:

**Trigger words** — when your message contains `advice`, `advisor`, or `get
consultation` (configurable via the `triggers` option; empty list disables),
the plugin appends a consult directive to your admitted prompt. The directive
distinguishes a consultation *request* ("give me advice" → consult now) from
a future-use *grant* ("you can use advisor if stuck" → remember, consult only
if genuinely stuck or before declaring done) — so a casual permission never
triggers immediate spend. The executor then calls the `advisor` tool with
full context and refines its answer:

```text
you:  this deploy plan looks risky — get consultation before proceeding
      ↓ (directive appended automatically)
exec: → advisor() → advice → refined plan citing the advice

you:  you can use the advisor if you get stuck
      ↓ (directive appended, grant recognized)
exec: works solo, consults only if stuck
```

**`/advisor` command** — V2 registers it automatically (`/advisor [focus]`);
on V1 copy `commands/advisor.md` into `~/.config/opencode/commands/` (or your
project's `.opencode/commands/`). Same flow, explicit invocation.

**`/advisor-settings` command** — guided model selection mirroring the
`/models` UX pattern. V2 renders your authoritative model catalog; the
executor asks via the native `question` tool (model, then variant/thinking
effort) and writes your choice into the plugin's `opencode.json` options —
a transparent diff you can inspect, applied via hot-reload. On V1 copy
`commands/advisor-settings.md` the same way (the executor reads your
configured providers itself).

**Credit attribution** — advice arrives framed as `ADVISOR REVIEW by
<provider/model>`, and executors credit the source when they use it
("per <model>: ..."), so you always know whose judgment contributed — and
which model to switch when it doesn't.

| Option | Default | Description |
|---|---|---|
| `triggers` | `["advice","advisor","get consultation"]` | Case-insensitive substrings routing user messages to the flow; `[]` disables |
| `nudge` | `"off"` | Under-calling nudge is OPT-IN (autonomous spend); `"on"` enables, `"auto"` limits to small-tier executors |

### Permissions

The advisor is a read-only escalation (it never touches tools, sessions, or
history) and OpenCode pre-approves tools with no matching rule, so there is
no approval friction by default. If you run a restrictive setup that asks for
every tool, allow it explicitly:

```jsonc
{ "permissions": [{ "action": "advisor", "resource": "*", "effect": "allow" }] }
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
