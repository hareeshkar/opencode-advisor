# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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
