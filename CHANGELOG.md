# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.5.0] — 2026-09-26

### Added
- **Safe-by-default unconfigured state**: fresh installs load with NO advisor
  model (zero spend), register the tool anyway, and answer consults with a
  setup-carrying `not_configured` error (steps for `/advisor-settings` and
  the declarative option) that the executor relays — a README at the moment
  of need, never invented advice. No timing/nudge injections while
  unconfigured (token discipline).
- **Runtime advisor hot-swap + RPC** (`opencode-advisor/get|set|reset`):
  `/advisor-settings`-style configuration applies immediately via plugin
  storage, no config editing, no restart; override survives restarts and
  can be reset back to the declarative option.
- **Transient consult directives**: trigger words and `/advisor` deliver
  their directive as invisible system text; user messages and history are
  never modified or bloated.

### Changed
- `/advisor-settings` uses a curated shortlist (current first, frontier-tier
  ranked, typed custom answer still possible) instead of dumping the full
  catalog into the conversation.
- README restructured: install → configure → use, with the `/advisor-settings`
  one-command path first.

## [0.4.0] — 2026-09-25

### Added
- **`/advisor-settings` command**: guided model + variant selection mirroring
  the `/models` UX — plugin renders the authoritative catalog, executor asks
  via the native `question` tool, choice lands in `opencode.json` (V2
  transform; V1 file + catalog-assist hook).
- **Credit attribution**: advice framed as `ADVISOR REVIEW by <model>`;
  executors credit the source when they use it.

## [0.3.0] — 2026-09-25

### Added
- **Native triggering stack**: task.txt-style tool description (WHEN +
  WHEN-NOT + usage notes — the description is the router), trigger-word
  routing (`advice`/`advisor`/`get consultation`, configurable, marker-
  guarded against doubles), `/advisor` command (V2 programmatic
  registration + V1 `commands/advisor.md` file + `command.execute.before`
  interception), transient timing/nudge guidance.
- **Dual-version slash commands**: V1 file-based + `command.execute.before`
  interception (server-source-verified live refs); V2 transform
  registration with disposal.
- **Frugal-by-default UX**: no autonomous advisor spend — tool description,
  timing prompt, and default `nudge: "off"` all enforce user-gated
  escalation (explicit request, `/advisor`, or granted stuck-use); the
  trigger directive distinguishes request-now from permit-later.

### Verified
- 100 tests green, including fake-ctx V2 setup tests and direct V1 hook tests.
- Research: V1/V2 command systems, server-source hook semantics, permission
  defaults (`ask` on no-match in V1; preapproved in V2), Anthropic tool-
  design guidance, local skill invocation patterns (description-only —
  no duplicate skill surface added, documented decision).

## [0.2.0] — 2026-09-25

### Added
- **Session-routed transport**: advisor sub-calls go through session-scoped
  `session.generate` (the only primitive that emits session hooks and
  inherits native session headers) with a **switchModel sandwich** for model
  selection — validated live, including a bogus-id negative probe.
- **Nonce-correlated header injection**: `http.request` hook attaches
  `x-opencode-session` to sub-call native requests (required by
  session-routed providers like opencode-go; enables their prompt caching).
- **Recursion defense**: `generate`-kind hook strips the tool catalog on
  exact nonce match, plus advisor prompt rule 4 (no tools, plain text).
- **Permanent observability**: `diag:health` per consult,
  `diag:hookcheck` per session, debug-gated diag tails on errors.
- **Setup race-guards**: unproven hook registrations time out instead of
  hanging setup (a hang once took the tool down silently).

### Fixed
- V2 tool evidence extraction rewritten against the real ToolState union.
- Success-counted caps + attempt ceiling + in-flight reservation.
- Error redaction, advice sanitization + framing, exact budget accounting.

### Verified
- 83 unit/integration tests green; 6 benchmark arms all green with zero
  plugin interference; first true E2E (kimi executor + deepseek-v4.1-flash
  advisor) returned sharp budget-respecting strategy faithfully consumed.
- Full report: `logs/sessions/bench/REPORT.md`.

## [0.1.0] — 2026-09-25

### Added
- **Core advisor engine** (`src/engine.ts`): mid-task escalation from any executor
  model to any advisor model, with per-task call caps, native-compatible error
  codes (`max_uses_exceeded`, `too_many_requests`, `overloaded`,
  `prompt_too_long`, `execution_time_exceeded`, `model_not_found`,
  `unavailable`), timeout enforcement, and physical output caps.
- **Transcript pruner** (`src/pruner.ts`): single-pass O(n) context compression —
  ANSI stripping, tool-output head+tail truncation with elision markers, noise
  dropping (npm/deprecation/progress-bar output), recency-weighted budget with
  original-task pinning. Typical prune ratio ≤ 0.35 of raw transcript chars.
- **V2 plugin adapter** (`src/v2.ts`): zero-arg `advisor` tool via
  `ctx.tool.transform`; transient system injection via
  `ctx.session.hook("context")` (timing prompt once per task, nudge for
  small-tier executors); task reset via prompt hook; advisor sub-call through
  `ctx.generate.text` (no session, no tools, no history pollution);
  startup self-probe with loud status (silent-failure defense).
- **V1 compatibility adapter** (`src/v1.ts`): `server()` hooks object
  (`chat.message`, `experimental.chat.system.transform`, `tool` map) with
  direct provider HTTP clients (Anthropic Messages + OpenAI-compatible).
  Experimental; V2 is the verified path.
- **Usage ledger**: durable aggregate (calls, estimated tokens in/out) via
  `ctx.storage` (V2) or `~/.cache/opencode-advisor/` JSON (V1).
- **Dual-export entrypoint**: one default export serves V2 (`setup()`) and
  V1 ≥ 1.18.29 (`server()`), per the officially documented packaging pattern.

### Engineering
- Zero runtime dependencies; type-only SDK imports; Node builtins only.
- Bundles to a single ESM file via esbuild for copy-into-place installation.
- Prompt-injection defense: pruned transcript is framed as evidence data with
  explicit ignore-instructions instruction to the advisor.
