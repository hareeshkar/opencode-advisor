# Investigation — Initial Context Acquisition (V1/V2 + Advisor API)

**Date:** 2026-09-25
**Investigator:** primary session (GLM-5.3) + mimo-v2.6-flash-free subagents
**Status:** COMPLETE (see file inventory)

## Objective

Acquire full engineering context for the model-agnostic advisor plugin:
native Anthropic advisor mechanics, OpenCode V1 vs V2 plugin APIs, full docs
scrape, local install audit, and GitHub bug intelligence — all cached as files
under `opencode-advisor/` so later phases never re-fetch.

## Chronology

1. **Spec saved** → `ADVISOR_RESEARCH_SPEC.md` (verbatim from user).
2. **Phase A research** (Anthropic advisor tool) — fetched platform.claude.com
   advisor-tool page + LiteLLM implementation page. Confirmed: beta header
   `advisor-tool-2026-03-01`, tool type `advisor_20260301`, empty server_tool_use
   input, 400–700-token advice, result variants (plaintext/encrypted/error codes),
   nudge behavior (+7pp Haiku, neutral Sonnet, negative Opus), usage.iterations
   accounting, model-compatibility matrix, platform availability (Anthropic API
   only — NOT Bedrock/Vertex/Foundry). LiteLLM's `AdvisorOrchestrationHandler` =
   reference client-side emulation loop. → `research/phase-a-advisor-api.md`
3. **Phase B research** (OpenCode lifecycle) — fetched v2 docs plugins guide +
   both migration guides. Confirmed config tuple→object, hook crosswalk
   (chat.params → session.hook("context") etc.), dual-export packaging pattern
   (`setup()` + `server()`), and the decisive primitives: `ctx.generate.text`
   (no session/tools/history), `ctx.tool.transform`, `ctx.session.hook("context"/"retry")`,
   `ctx.permission.rules`, `ctx.storage`. → `research/phase-b-opencode-lifecycle.md`
4. **Local recon** — `opencode v2.0.16` at `~/.opencode/bin/opencode` (178MB Bun
   binary, symlinked from /usr/local/bin). User config mixes V1-shaped keys
   (`agent`, `provider`, singular) normalized by V2. Living V2 plugin examples on
   disk: rtk.ts, skillful.ts, subagent-delegate.ts (dual V1/V2 export).
   `@opencode/plugin@2.0.16` npm == binary version.
5. **Type packages extracted** — npm-packed + untarred @opencode/plugin@2.0.16,
   @opencode-ai/plugin@1.18.32, @opencode/client@2.0.16, @opencode/schema@2.0.16,
   @opencode/ai@2.0.16 into `research/api-types/`. Key finds: `Tool.Context`
   carries **sessionID** (tool executors are session-aware); full V1 Hooks
   interface captured verbatim; Context has an undocumented `aisdk` domain.
6. **Docs scrape** — V2: 56/56 pages via `curl -H "Accept: text/markdown"`
   (1.37MB; `/sharing/` is a 60-byte stub → dropped). V1: 36/36 English pages
   from raw.githubusercontent (anomalyco/opencode, 440KB). Plus `openapi.json`
   (532KB). → `research/docs-scrape/{v2,v1}/`
7. **Repo identification** — V2 = `opencode-ai/opencode` (13.7k★), V1 lineage =
   `anomalyco/opencode` (209k★, ex-sst). awesome-opencode ecosystem surveyed
   (arise, FlowDeck, oh-my-opencode-slim, open-dynamic-workflows).

### CORRECTION (2026-09-25, later same day — supersedes item 7)

Issue mining proved the repo mapping **inverted**:
- `opencode-ai/opencode` is **ARCHIVED** (last push 2025-09-18, `archived: true`
  via `gh api`; zero plugin/advisor hits in its tracker).
- `anomalyco/opencode` (209k★, ex-sst) is the **live** tracker for *both* V1 and
  V2 plugin issues (6,254 open) — V2-era issues (#44788, #50590, #40808, #50729…)
  all live there. Any future issue research or bug filing targets this repo.
- Evidence: `research/github-issues-bugs.md` §0 (repo topology finding).

### Design constraints adopted from issue mining (2026-09-25)

1. **Assume silent failure** — V2 hooks can register and deliver nothing
   (#44788, #40808, #50590 WARN-only loads). Plugin must self-probe at startup
   and surface visible status.
2. **Core path never depends on `event.subscribe`** (#44788 all forms dead in
   that beta) — trigger off the most-executed verified hooks instead.
3. **No mid-flight model switching** — `chat.params` cannot override
   providerID/modelID (#49712); no `chat.model` hook yet (#50729/#45764) ⇒ the
   advisor sub-call goes through our own client (`ctx.generate.text` /
   direct fetch), never through session re-routing.
4. **Prior art demand confirmed** — advisor strategy requested twice in core
   (#21789, #23058), both closed unfilled; zero advisor plugins exist in the
   ecosystem census. The plugin niche is open.

## Operational gotchas logged

- **zsh word-splitting**: `for x in $var` treats the whole string as one item →
  always `bash -c` with arrays for scrape loops. Cost: one failed background scrape.
- **Subagent model routing**: the configured `general-mimo-v2-5-free` agent maps to
  a dead model id (`opencode/mimo-v2.5-free` → "Model unavailable"). Fix: dispatch
  with explicit `model: "opencode/mimo-v2.6-flash-free"` (200k ctx). Verified live.
- **Docs scrape method**: V2 docs serve markdown via `Accept: text/markdown` header
  (NOT via `.md`/`.mdx` suffixes — 404). V1 docs are HTML-only → scrape from repo
  raw files instead.
- **webfetch truncation**: large pages get truncated but the full text is cached at
  `~/.local/share/opencode/tool-output/tool_*` — read those files for the remainder.

## File inventory (deliverables)

| File | Content |
|---|---|
| `research/phase-a-advisor-api.md` | Anthropic advisor mechanics + LiteLLM blueprint |
| `research/phase-b-opencode-lifecycle.md` | V1↔V2 hook crosswalk + config shapes |
| `research/vendor-matrix.md` | Executor×Advisor benchmark framework |
| `research/docs-scrape/v2/` (56 files) | Full V2 docs, markdown |
| `research/docs-scrape/v1/` (36 files) | Full V1 docs, mdx |
| `research/docs-scrape/v2/openapi.json` | V2 server OpenAPI spec |
| `research/api-types/*/` (5 pkgs) | Extracted .d.ts type sources |
| *(subagent outputs — see README index)* | combined docs, issue digest, API surface ref, env audit |

## Open questions carried forward

1. ~~`GenerateTextInput` full field surface~~ **RESOLVED 2026-09-25**: `prompt` + optional
   `Model.Ref` only — no options/system/temperature ⇒ advisor output budget and role
   framing must be prompt-enforced (consistent with Anthropic's own "<100 words,
   enumerated steps" cost-reduction guidance). See `API_SURFACE_REFERENCE.md` §4.
2. Whether `generate.text` accepts output-token caps per provider → **resolved NO by §4**;
   remaining sub-question: provider-side default output caps for the advisor models
   (benchmark question — record actual advice lengths).
3. Nudge transferability to non-Anthropic small executors (benchmark question).
4. ~~V2 repo issue-tracker depth~~ **RESOLVED**: opencode-ai/opencode archived;
   anomalyco/opencode is the live tracker (see CORRECTION below).

## Phase close-out (2026-09-25, end of day)

Context-acquisition phase COMPLETE. All five subagent deliverables verified:
docs assembly (547KB V2 + 452KB V1, HTML-stubbed, deterministic assembler),
issue mining (repo topology + 12 implications), API surface (1,485 lines),
local env audit (453 lines). Total workspace ≈ 4.5MB of cached, greppable
context. Zero further network fetches required to begin implementation.
Additional API facts: V1 package ships its own `./v2/promise` 9-domain bridge
context; 5 V1 hooks have no V2 equivalent; OpenAPI = 136 ops / 113 paths /
2 SSE endpoints with `security: []` declared.
