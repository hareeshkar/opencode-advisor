# Local Native Invocation Patterns — OpenCode v2.0.16

Survey of `/Users/hareeshkarravi/.config/opencode/` (read-only). How tools, skills,
commands, rules and plugins get triggered natively — i.e. without the user (or a
plugin) injecting prompt text.

Date: 2026-09-25

---

## 1. Skills (`~/.config/opencode/skills/`, 74 dirs)

### Inventory
- **74 skill directories**, each with exactly one `SKILL.md` (no nested/alt names).
- 73 skills have YAML frontmatter; **`cli-research-agent` has no frontmatter at all**
  (starts directly with `# Skill: CLI Research Agent` — it is prose-only and cannot
  be auto-matched by description).
- **15 skills ship extra files** alongside `SKILL.md` (references/scripts):
  `systematic-debugging` (11 files), `writing-skills` (7), `supabase` / `doc` /
  `brainstorming` / `subagent-driven-development` / `android-emulator-qa` /
  `ui-ux-pro-max` / `generated-pdf` (3–4 each).

### Exact frontmatter fields (frequency over 73 files)
| Field | Count | Notes |
|---|---|---|
| `name` | 73 | kebab-case, matches directory name except `taste-skill/` → `name: design-taste-frontend` |
| `description` | 73 | the only invocation signal; written for the model |
| `disable-model-invocation` | 11 | `true` = user/slash-invoked only |
| `metadata` | 6 | `surfaces`, `author`, `version`, `organization`, `abstract` (Cursor-style) |
| `environments` | 6 | e.g. `local`, `cloud` |
| `version` | 5 | semver string |
| `disabled-environments` | 3 | e.g. `cloud` |
| `license` | 2 | `MIT`, `Apache 2.0` |

**There is no `autoinvoke`, `context`, or `tools` frontmatter field anywhere.** Only one
mention of the concept exists, in `create-skill/SKILL.md` body:

> "Default `disable-model-invocation: true` so the skill only loads when named
> explicitly. Omit it only when the agent should auto-invoke from ambient context."

So native model-invocation is **opt-out via `disable-model-invocation`**, and the
sole ambient trigger is the `description`.

`disable-model-invocation: true` skills (11): `api-pr-review`,
`assignment-writing-average`, `create-subagent`, `cursor-orchestrator`, `goal`,
`migrate-to-skills`, `onboard`, `opencode-orchestrator`, `rename-chat`, `review`,
`shell`. These are slash-command / explicit-name surfaces.

### Description writing conventions (stats over 73)
- Average **43.7 words** (median 34, min 6, max 127); 24 descriptions begin with `Use`.
- Phrase frequency: `Use when` ×49, `Trigger`/`Triggered by` ×7,
  `This skill should be used` ×4, `USE THIS` ×2, `Do NOT use` ×3, `MUST use` ×2.
- Style is **third-person, "the user asks X" imperatives**, often with an explicit
  activation trigger followed by a scope fence ("Do NOT use for...").

### 3 best trigger examples (verbatim)
1. `drawio` (single-sentence, verb list, near-guaranteed match):
   > "Always use when user asks to create, generate, draw, or design a diagram,
   > flowchart, architecture diagram, ER diagram, sequence diagram, class diagram,
   > network diagram, mockup, wireframe, or UI sketch, or mentions draw.io, drawio,
   > drawoi, .drawio files, or diagram export to PNG/SVG/PDF."

2. `jpeg-to-svg` (explicit keyword + "USE THIS whenever" + no-synonym hedge):
   > "USE THIS whenever the user asks to vectorize or trace an image, 'convert this
   > logo to SVG', 'make an SVG from this PNG/JPEG', 'turn an image into an animated
   > SVG' ... even if they don't say 'SVG' explicitly."

3. `backend-explorer` (trigger/anti-trigger pair + routing to a sibling skill):
   > "Use when you need to verify backend API contracts ... Triggered by: 'check the
   > backend', 'what does the API return', 'verify against backend', 'confirm the DTO'
   > ... For operational flows, use backend-flow-extractor first."

Also notable: `supabase` packs a keyword taxonomy into one description
("Triggers: Supabase products (Database, Auth, Edge Functions, ...)").

### Auto-invoking skills
None declare an auto-invoke flag. Native auto-selection is entirely dependent on the
harness model-matching the `description`; only the 11 `disable-model-invocation`
skills are explicitly blocked from that. `using-superpowers` is the closest thing to a
*meta* auto-trigger and is written to fire at conversation start:

> "Use when starting any conversation - establishes how to find and use skills,
> requiring skill invocation before ANY response including clarifying questions"

with an in-body override guard:

> `<SUBAGENT-STOP> If you were dispatched as a subagent to execute a specific task,
> ignore this skill. </SUBAGENT-STOP>`

### Directory / naming conventions
- Directory name is kebab-case and equal to `name` in 73/74 cases.
- `taste-skill/` is the one mismatch (dir is the repo slug; `name: design-taste-frontend`).
- Resources live in subdirectories under each skill dir; referenced by relative path.

---

## 2. Commands & Rules

### `commands/` — 1 file: `reload-subagents.md`
Frontmatter is minimal — **only `description`**:
```yaml
---
description: Rediscover models from all connected providers and regenerate subagents (20s timeout)
---
```
Template style: an immediate **shell-injection block using the `!` prefix backtick**:
> ``!`cd ~/.config/opencode && npx tsx scripts/reload-subagents.ts 2>&1` ``

then numbered post-execution instructions ("If it succeeded: ...", "If it failed: ..."),
and a hard constraint ("Do NOT suggest the user modify opencode.json manually.").
No `$ARGUMENTS` token is used here (this command takes none), but the pattern is the
native command mechanism.

### `rules/` — 1 file: `lean-ctx.md`
A Markdown rule (no frontmatter), wrapped in HTML-comment version tags
(`<!-- lean-ctx-rules-v9 -->`). It steers tool preference with a table
(`PREFER` | `OVER` | `Why`), e.g. "PREFER `ctx_read(path, mode)` OVER `Read` / `cat`",
then lists modes and a **"Proactive (use without being asked)"** section
(`ctx_overview(task)` at session start, `ctx_compress` when context grows large).
This is the only rules file and it works by instruction pressure, not wiring.

---

## 3. Global `AGENTS.md`

Fully read (1,344 bytes). Entirely a **context7 MCP usage directive**, delimited by
`<!-- context7 -->` comment fences:
- "Use Context7 MCP to fetch current documentation whenever the user asks about a
  library, framework, SDK, API, CLI tool, or cloud service ... Prefer this over web
  search for library docs."
- An explicit negative scope: "Do not use for: refactoring, writing scripts from
  scratch, debugging business logic, code review..."
- A 4-step procedure (`resolve-library-id` → match → `query-docs` → answer).

**No delegation / subagent / model-selection guidance lives in AGENTS.md.** That
guidance is supplied natively at runtime by the `subagent-delegate` plugin's
`session.hook("context")` (see §4), which injects the `## Subagent delegation`
system block (routing policy, `task`/`delegate`/`discover_models`, model-selection
rules). AGENTS.md steers *tool choice* (context7 over web search); the plugin steers
*delegation*.

---

## 4. Plugins (`~/.config/opencode/plugins/`)

Note: `subagent-delegate` is a **directory** (`index.ts`, `config-models.ts`,
`listing.ts`), not a single `.ts` file.

| Plugin | Native mechanism(s) | Purpose |
|---|---|---|
| `rtk.ts` | `ctx.tool.hook("execute.before")` in `setup`; preflight `rtk --version` disables the hook when binary is absent | Rewrites `bash`/`shell` tool commands via `rtk rewrite "<command>"`, replacing `event.input` wholesale; skips commands already prefixed `rtk ` |
| `skillful.ts` | `ctx.tool.transform(editor => editor.add(...))`; `ctx.session.synthetic({sessionID, text})` | V2 shim re-registering the vendored V1 `@zenobius/opencode-skillful` tools: `skill_use`, `skill_find`, `skill_resource` (hand-written JSON Schema); converts V1 `prompt({noReply:true})` into `session.synthetic` |
| `subagent-delegate/index.ts` | `ctx.session.hook("context")`; `ctx.tool.transform` (`editor.add`); `ctx.model.list()`; `ctx.session.create` / `prompt` / `wait` / `context` / `interrupt` | Injects `## Subagent delegation` system hint (dedup-guarded), registers `discover_models`, `task`, `delegate` tools; runs child sessions parented via `parentID` |

Key observations:
- Two distinct native surfaces are used: **tool registration** (`ctx.tool.transform`)
  and **system-prompt injection** (`ctx.session.hook("context")`), plus a tool-call
  interceptor (`ctx.tool.hook("execute.before")`).
- Both tool plugins return a default object with an `id` and `async setup(ctx)`.
- The system-hint injection is what makes delegation guidance appear *without* being
  in AGENTS.md — it de-duplicates by scanning for `"## Subagent delegation"`.

---

## 5. `opencode.json` top-level keys (names only)

Present: `$schema`, `plugins`, `compaction`, `watcher`, `provider`, `mcp`, `agent`.

Non-secret shapes:
- `$schema`: string URL (`https://opencode.ai/config.json`).
- `plugins`: list length 1; entry is `{ package: './opencode-advisor', options: {...} }`
  (advisor provider/model, `adviceWordBudget`, `maxUsesPerTask`, `logLevel`) — no secrets.
- `compaction`: dict (`auto`, `prune`, `reserved`).
- `watcher`: dict (`ignore`).
- `provider`: dict with keys `bailian-token-plan`, `meta`, `mimo` (model catalogs).
- `mcp`: dict with key `context7`.
- `agent`: dict of **39 generated subagents**, names following
  `<mode>-<provider>-<model>[-<reasoningEffort>]` e.g.
  `explore-deepseek-v4-flash-free-high`, `implement-bailian-token-plan-deepseek-v4-pro-high`.
  Each agent shape: `{ mode, model, reasoningEffort, description }` (mode is always
  `subagent`; descriptions 143–156 chars). These are the native delegation targets.

---

## NATIVE TRIGGERING PATTERNS

- Skill activation is **description-only**: there is no `autoinvoke`/`context`/`tools`
  frontmatter field in any of 74 skills; the model matches on `description` alone.
- Descriptions are **`Use when …` / `Triggered by: …` third-person imperatives** —
  `Use when` appears in 49/73 (67%), averaging **43.7 words** (range 6–127).
- **11/74 skills opt out with `disable-model-invocation: true`** and are reachable only
  by explicit name or slash command (`shell`, `review`, `goal`, orchestrators, etc.).
- Slash-invoked skills encode their own trigger in the description ("Use only when the
  user explicitly invokes `/shell`", "Use `/visualize` …", "`/loop 5m /foo`").
- Best-match descriptions combine an **action keyword list + named trigger phrases +
  an explicit negative scope** ("Do NOT use for …", "For X, use <sibling> first").
- **`cli-research-agent` has no frontmatter**, so it is structurally un-triggerable by
  description — a concrete anti-pattern for advisor skills.
- Commands use **`description`-only frontmatter + `!` backtick shell injection**; the
  `$ARGUMENTS` template convention is available but unused in the one local command.
- Rules steer behavior by **instruction pressure and PREFER/OVER tables**, not wiring
  (`rules/lean-ctx.md`); there is no rules registry.
- Global `AGENTS.md` steers **tool choice only** (context7 over web search); it carries
  **zero delegation/model-selection guidance**.
- Delegation guidance is injected **natively at runtime** by
  `subagent-delegate`'s `ctx.session.hook("context")`, which appends a
  `## Subagent delegation` system block — the model never has to be told to read it.
- Plugins choose among three native mechanisms: `ctx.tool.transform` (register tools),
  `ctx.tool.hook("execute.before")` (rewrite tool input), and
  `ctx.session.hook("context")` (inject system text) — plus `ctx.session.synthetic`
  for silent no-reply context.
- **39 generated `subagent` entries** in `opencode.json` (naming
  `<mode>-<provider>-<model>[-<effort>]`) are the native delegation targets that make
  `task`/`delegate` model routing resolvable without extra prompt text.
