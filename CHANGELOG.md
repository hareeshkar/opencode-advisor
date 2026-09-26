# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.8.0] — 2026-09-26

### Added
- **Async advisor consults**: the 90-second window is now a *response wait*,
  not a kill switch. Launch failures fail fast (`advisor_not_running —
  <reason>`); consults that need longer keep running in the background and the
  tool returns `ADVISOR CONSULT RUNNING` (id + elapsed + "You do not need to
  start another consultation"). New **`advisor_status`** tool lists this
  session's consults (running/completed/failed + elapsed + delivery state) and
  replays delivered advice. Completed background consults are auto-delivered
  through the native injection channel on the executor's next model call, and
  recorded in a consult ledger (last 100) with a setup-time reaper for entries
  that outlive the ceiling.
- `advisorResponseWaitMs` (default 90s — **uniform across presets**: presets
  scale budget, never patience) and `maxConsultMs` (default 1h ceiling; expiry
  fails the consult WITHOUT consuming the consult cap). Concurrency guard: ≤2
  running consults; rejections never consume the cap. Consults own their
  AbortController — executor interruption cancels waiting, never thinking.

### Changed
- Review-mode transport is now history-less direct generation first
  (`generate.text`), isolated session sandwich as fallback; the calling
  session's model is never switched on the common path.
- `timeoutMs` accepted as a deprecated alias for `advisorResponseWaitMs`
  (the new key wins when both are set; the wait is clamped to ≤ `maxConsultMs`).

## [0.7.1] — 2026-09-26

### Fixed
- **Advisor sub-calls are now truly history-less.** `session.generate` is
  session-scoped — the host attaches the caller's conversation, so review-mode
  consults could adopt the executor's identity in advisor-saturated sessions
  (live-verified: role contamination, echo episodes). The generate hook now
  ISOLATES the request for correlated sub-calls: history messages dropped,
  system parts emptied, tools emptied. Verified at the wire level: the
  outbound body carries exactly one message (the advisor prompt), zero system
  parts, zero tools.
- **Direct transport first**: review consults use `generate.text({ prompt,
  model })` — history-less by construction, no model-switch/restore sandwich —
  with the isolated session sandwich as automatic fallback (e.g. hosts where
  the direct call lacks provider routing). `session.generate` no longer runs
  on the common path.

### Added
- Transport + isolation diagnostics: `diag:body` (privacy-safe outbound
  summary for advisor calls only — message/system/tool counts and
  contamination needle flags), `diag:generate` (isolation ledger:
  kept/dropped/systemStripped), `msgDrop`/`sysStrip`/`transport` in debug
  output. Known platform gap documented: plugins cannot delete sessions, so
  agent-mode "advisor consult" children may remain (read-only, tagged).

## [0.7.0] — 2026-09-26

### Added
- **File-as-truth configuration**: `opencode-advisor.json` (global + project;
  project wins) with per-key provenance, atomic tmp+fsync+rename writes, and
  a one-time migration of the pre-0.7 stored pick. Manual JSON edits and the
  settings UI edit the same file; **Inherit** removes a key instead of
  freezing today's value.
- **Token-native budgets**: `adviceTokenBudget` = advisor OUTPUT tokens
  (presets 4K/8K/16K/32K; range 500–64K — model max-output caps are typically
  8K–65K) and `transcriptBudgetTokens` = INPUT context (presets
  8K/16K/32K/64K; range 2K–1M; chars derived ×4 for the pruner). A preset
  whose exact quantities no longer match displays as **Custom** (computed,
  never persisted).
- **Full settings menu**: `/advisor-settings` edits Model (live catalog,
  variants, custom, Inherit), Preset (with consequences), Mode
  (Review / Review + Agent), and Limits (consults, timeout, context tokens,
  advice tokens, per-tool cap, retry ceiling, log level). Draft → Save (one
  atomic write) or Cancel; nothing writes until Save.
- **Evidence hygiene (fixes a live degeneration)**: prior advisor replies and
  trailing in-flight assistant drafts are excluded from consult evidence, and
  the advisor prompt forbids continuing/narrating consultation machinery.

### Changed
- **Manual-only by design**: removed the nudge, the executor timing prompt,
  and all grant/"stuck" semantics — no explicit user request (trigger words,
  `/advisor`, or a direct ask), no consultation, no spend. Unconfigured
  installs answer with setup steps (model is the only required choice;
  Balanced preset and all limits are pre-tuned) and cost nothing.
- **Review + Agent** naming: the read-only child session gets the pruned
  conversation as its MAP and verifies implicated files as the TERRITORY
  (`review-agent` accepted as a config alias).
- Retry ceiling documented as transport attempts — never extra paid consults.

### Removed
- Storage override (`advisor:override`), timing/nudge prompt assets and tier
  heuristics, and word-based budget knobs in favor of token budgets.

## [0.5.0] — 2026-09-26

### Added
- **Native TUI settings picker** (bundled CLI plugin `tui.js`, discovered by
  filename convention): `/advisor-settings` opens a real `dialog.select`
  picker like `/models` — model from the live catalog, then variant/thinking
  effort, saved over RPC. Zero conversation tokens. The TUI claims the UI
  (`claim` RPC) so the server-side executor flow is suppressed — exactly one
  slash entry; hosts without CLI plugin support keep the executor fallback.
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
