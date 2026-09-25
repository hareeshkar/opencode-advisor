# Local OpenCode V2 Environment Audit

Audited: 2026-09-25 · Host: macOS (darwin/arm64) · User: `hareeshkarravi`
Scope: binary topology, user config, plugins, skills, data dir + SQLite schema, logs, commands/rules.

> **Secrets policy:** this document contains **no** API keys, tokens, passwords or auth values. Where a credential-bearing field exists, only the *field name* is recorded and the value is marked `PRESENT (redacted)`.

---

## 1. Binary & symlink topology

Producing commands:

```sh
ls -la /usr/local/bin/opencode
readlink /usr/local/bin/opencode
ls -la ~/.opencode/bin/
file ~/.opencode/bin/opencode
cat ~/.opencode/bin/opencode2
du -sh ~/.opencode/bin/opencode
/usr/local/bin/opencode --version
```

| Item | Detail |
|---|---|
| PATH entry | `/usr/local/bin/opencode` → symlink, owner `root:wheel`, 44 bytes, dated 24 Sep 00:47 |
| Symlink target | `/Users/hareeshkarravi/.opencode/bin/opencode` (single hop, no intermediate links) |
| Real binary | `~/.opencode/bin/opencode` — **178,602,224 bytes (170M on disk)** |
| Format | `Mach-O 64-bit executable arm64` (Bun-compiled; `strings` deliberately **not** run) |
| Version | `opencode v2.0.16` (`opencode --version`) |
| Shim | `~/.opencode/bin/opencode2` — **47 bytes**, mtime 25 Sep 15:11 |
| Extra symlink | `~/.opencode/bin/rtk` → `/Users/hareeshkarravi/.local/bin/rtk` (36-byte link) |

`opencode2` full content (47 bytes):

```sh
$ cat ~/.opencode/bin/opencode2
#!/bin/sh
exec "$(dirname "$0")/opencode" "$@"
```

Observation: `opencode2` is a re-exec shim — it always forwards to the *real* binary next to it, so both names resolve to v2.0.16. The `rtk` symlink puts the `rtk` CLI (used by the `rtk` plugin, §3) on the same PATH directory.

---

## 2. Config dir `~/.config/opencode/`

Producing commands:

```sh
ls -la ~/.config/opencode/
du -sh ~/.config/opencode/*
cat ~/.config/opencode/package.json
cat ~/.config/opencode/config.json
cat ~/.config/opencode/service.json        # password value redacted in this doc
python3 -c 'import json;...json.load(open(".../opencode.json"))'   # structure only
```

| Entry | Size | Notes |
|---|---|---|
| `AGENTS.md` | 1,344 B | global agent instructions (Context7 instructions block) |
| `commands/` | 4.0K | 1 file — see §7 |
| `config.json` | 51 B | only `{ "$schema": "https://opencode.ai/config.json" }` |
| `opencode.json` | 22,631 B (24K) | main user config — structure below |
| `package.json` | 127 B | see below |
| `plugins/` | 48K | 3 `.ts` plugins — see §3 |
| `rules/` | 4.0K | 1 file — see §7 |
| `service.json` | 64 B | `{"password": "…REDACTED…"}` — **a password field exists; value never reproduced** |
| `skills/` | 10M | 74 skill dirs — see §4 |
| `vendor/` | 816K | `opencode-skillful.js` (833,062 B) — see §3 |

`package.json` (full, no secrets):

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.4.9",
    "@zenobius/opencode-skillful": "^1.2.5"
  },
  "type": "module"
}
```

> Note: `"type": "module"` is what lets the V2 loader import the `.ts` plugins as ESM.

### `opencode.json` structure (top level)

Command: `python3` `json.load` → print keys, per-key subkeys, array lengths.

| Top-level key | Shape |
|---|---|
| `$schema` | `str` → `https://opencode.ai/config.json` |
| `plugins` | `list[0]` — **empty** (plugins are nonetheless loaded from `plugins/`, §3) |
| `compaction` | `dict[3]` → `auto`, `prune`, `reserved` (`{"auto":true,"prune":true,"reserved":120000}`) |
| `watcher` | `dict[1]` → `ignore` (7 glob entries: `.git/`, `bin/`, `obj/`, `node_modules/`, `coverage/`, `.opencode/`) |
| `provider` | `dict[3]` → `bailian-token-plan`, `meta`, `mimo` |
| `mcp` | `dict[1]` → `context7` |
| `agent` | `dict[39]` |

### Providers

Command: iterate `d["provider"]` printing keys/model-id lists (values of `options` not printed).

| Provider ID | `npm` | `name` | `options` keys | models |
|---|---|---|---|---|
| `bailian-token-plan` | `@ai-sdk/anthropic` | Alibaba Cloud Model Studio | `baseURL`, `apiKey` = **PRESENT (redacted)** | 15 |
| `meta` | `@ai-sdk/openai` | Meta Model API | `baseURL`, `apiKey` = **PRESENT (redacted)** | 1 |
| `mimo` | `@ai-sdk/openai-compatible` | MiMo | `baseURL`, `apiKey` = **PRESENT (redacted)** | 2 |

Model-id lists:

- `bailian-token-plan` (15): `qwen3.8-max-preview`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.2`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`, `glm-5.2`, `glm-5.1`, `glm-5`, `MiniMax-M2.5`
- `meta` (1): `muse-spark-1.1`
- `mimo` (2): `mimo-v2.5-pro`, `mimo-v2.5`

Per-model subkeys observed: `name`, `limit`, `options` (bailian, e.g. `thinking`/`temperature`/`reasoning`); `name`, `reasoning`, `limit`, `modalities`, `options` (meta, e.g. `reasoningEffort`/`reasoningSummary`/`include`); `name`, `limit`, `modalities` (mimo).

### Agents — 39 definitions, all `mode: "subagent"`

Command: `collections.Counter(tuple(sorted(a.keys())))` over `d["agent"]`.

| Shape | Count |
|---|---|
| `{description, mode, model, reasoningEffort}` | 33 |
| `{description, mode, model}` | 6 |
| **Total** | **39** (100% `mode = "subagent"`) |

Naming convention: `<role>-<provider>-<model>[-<effort>]` where role ∈ `explore` / `implement` / `general` and effort ∈ `low` / `medium` / `high` / `max` / `xhigh`.
Example: `explore-bailian-token-plan-deepseek-v4-pro-high` → `mode=subagent`, `model=bailian-token-plan/deepseek-v4-pro`, `reasoningEffort=high`.

Role × model-family spread: `bailian-token-plan/deepseek-v4-pro`, `deepseek-v4-flash-free`, `mimo-v2-5-free` × {explore, implement, general} × effort variants.
**The level-suffixed variants live in `agent.*` names — not in skill dir names (§4).**

### MCP

`mcp.context7` = `{type:"remote", url:"https://mcp.context7.com/mcp", enabled:true, headers:{CONTEXT7_API_KEY: "…REDACTED…"}}` — header *name* recorded, value redacted.

### Config normalization evidence (V1 → V2)

Command: `grep -a "configuration normalization diagnostic" ~/.local/share/opencode/log/opencode.log | tail -3`

```
level=WARN message="configuration normalization diagnostic" source=~/.config/opencode/opencode.json
  path=$.compaction.prune kind=unsupported action="omitted unsupported legacy setting"
level=WARN ... path=$.provider.meta.models.muse-spark-1.1.reasoning kind=unsupported
  action="omitted unsupported legacy setting"
```

So: **user config carries V1-era keys that V2 silently drops with a WARN**, rather than failing to load.

### Credential file shapes (filenames + field names only — no values)

Command: `python3` `json.load` → print `type(v).__name__` and key names only.

| File | Size | Shape |
|---|---|---|
| `~/.local/share/opencode/auth.json` | 3,766 B | `dict[providerID] → {type, key}` for 11 entries, or `{type, refresh, access, expires}` (OAuth) / `{…, accountId}` — 14 providers total (`openai`, `github-copilot`, `google`, `deepseek`, `opencode`, `opencode-go`, `meta`, `xiaomi`, `nvidia`, `minimax*`×3, `llmgateway`, `zai-coding-plan`) |
| `account.json` | 6,763 B | `{version: 2, accounts: dict[14] → {id, serviceID, description, credential}, active: dict[14] → accountId}` |
| `mcp-auth.json` | 445 B | `{supabase: {clientInfo:{clientId, clientSecret, clientSecretExpiresAt}, codeVerifier, oauthState, serverUrl}}` |
| `service.json` | 64 B | `{password: "…REDACTED…"}` |

---

## 3. Plugins `~/.config/opencode/plugins/`

```sh
ls -la ~/.config/opencode/plugins/ ~/.config/opencode/vendor/
head -30 ~/.config/opencode/vendor/opencode-skillful.js
grep -nE 'export default|Plugin\.define|server\(' *.ts
grep -ohE 'ctx\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\(' *.ts | sort -u
```

| File | Bytes | Lines |
|---|---|---|
| `rtk.ts` | 1,923 | 52 |
| `skillful.ts` | 5,832 | 148 |
| `subagent-delegate.ts` | 33,675 | 811 |
| `../vendor/opencode-skillful.js` | 833,062 | 23,556 |

**Vendor bundle format:** `head -30` starts with `// @bun`, then Bun's `__create`/`__defProp`/`__toESM`/`__commonJS`/`__export` helpers and `var __require = typeof import.meta.require === "function" ? … : (await import("node:module")).createRequire(...)`; first embedded module comment is `// node_modules/kind-of/index.js`.
→ **Bun-compiled single-file ESM bundle** (bundled `node_modules`, `import.meta.require` shim), not minified.

### Export shape (all three plugins)

| Plugin | Export style | `Plugin.define` | dual `server()` export | `id` |
|---|---|---|---|---|
| `rtk.ts` | `export default { id, async setup(ctx) }` (L17) | **not used** | **absent** | `rtk` |
| `skillful.ts` | `export default { id, async setup(ctx) }` (L18) | **not used** | **absent** | `opencode-skillful` |
| `subagent-delegate.ts` | `export default { id, async setup(ctx) }` (L585) | **not used** | **absent in this file** — mentioned only in the header comment | `opencode-subagent-delegate` |

Header of `subagent-delegate.ts` documents the intended dual shape (comment only, L4–L15):

```
The V1 implementation lives in v1.ts; index.ts exposes both from one default export
(OpenCode 2.x calls setup(), OpenCode 1.18.29+ calls server()).
- default export `{ id, setup }` (V1 named/functional exports are rejected by V2)
- tools registered via ctx.tool.transform(editor => editor.add(...)) with JSON Schema inputs
- system hint injected via ctx.session.hook("context") (was experimental.chat.system.transform)
- model catalog from ctx.model.list() with filesystem fallback
- execution: session.create -> session.prompt -> session.wait -> session.context;
  abort signal wired to session.interrupt
- V1 ctx.metadata() live Task-pane publishing dropped; child ids returned in ToolResult metadata
```

Verified by `grep -nE 'function server|server:|server =|\bserver\b *[(=]'` → only that comment matches. **Conclusion: on this install every loaded plugin is V2-only (`{id, setup}`); no `server()` and no `Plugin.define` are present.**

### V2 API surface actually called

Command: `grep -ohE 'ctx\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+\(' *.ts | sort -u` + per-call-site `grep -n`.

| Plugin | V2 API calls | Purpose |
|---|---|---|
| `rtk.ts` | `ctx.tool.hook("execute.before", …)` (L28) | rewrite `bash`/`shell` `event.input.command` in place before execution |
| `skillful.ts` | `ctx.session.synthetic({sessionID, text})` (L56)<br>`ctx.tool.transform(editor => editor.add(…))` (L113) | V1 `noReply` prompt shim; re-register `skill_use` / `skill_find` / `skill_resource` with hand-written JSON Schema |
| `subagent-delegate.ts` | `ctx.session.hook("context", …)` (L612)<br>`ctx.tool.transform(editor => editor.add(…))` (L619)<br>`ctx.model.list()` (L11)<br>`ctx.session.create({…, parentID})` (L458/460)<br>`ctx.session.interrupt({sessionID})` (L472/560)<br>`ctx.session.prompt({sessionID, text})` (L481)<br>`ctx.session.context({sessionID})` (L487)<br>`ctx.session.wait({sessionID})` (L528)<br>`ctx.session.get({sessionID})` (L542) | inject system hint; register `discover_models`, `task`, `delegate`; model catalog; child-session lifecycle with abort |

**Aggregate V2 plugin API observed:** `ctx.tool.hook`, `ctx.tool.transform`, `ctx.session.hook("context")`, `ctx.session.create/get/prompt/wait/interrupt/context/synthetic`, `ctx.model.list`, plus reads of `ctx.options` and `ctx.location.directory`.
`grep -nE 'ctx\.storage' *.ts` → **no matches** (no plugin here uses `ctx.storage`).

Tool registration names added via `editor.add({name: …})` in `subagent-delegate.ts`: `discover_models` (L621), `task` (L665), `delegate` (L741).

Tool-execution context fields read by plugins: `toolCtx.sessionID`, `toolCtx.agent`, `toolCtx.messageID`, `toolCtx.signal` (abort), `toolCtx.progress`; returned metadata keys: `sessionId`, `parentSessionId`, `model.{providerID,modelID}`.

Plugin options read via `ctx.options` (L31–40): `raw["opencode-subagent-delegate"] ?? raw["model-router"]`, else the flat object; defaults `{preferredProviders:{}, registryTtlMs:300000, hintInSystemPrompt:true}`.

### Loading evidence (config `plugins: []` yet all three load)

Command: `grep -a "plugin" ~/.local/share/opencode/log/opencode.log | grep -aiE "rtk|skillful|delegate|loaded"`

```
level=INFO msg="loading plugin" id=~/.config/opencode/plugins/rtk.ts
             entrypoint=file:///Users/hareeshkarravi/.config/opencode/plugins/rtk.ts role=server
level=INFO msg="loading plugin" id=~/.config/opencode/plugins/skillful.ts     entrypoint=file://… role=server
level=INFO msg="loading plugin" id=~/.config/opencode/plugins/subagent-delegate.ts entrypoint=file://… role=server
level=INFO message="watcher subscribe" path=~/.config/opencode/plugins/<file> type=file role=server
```

→ `~/.config/opencode/plugins/*.ts` is **auto-discovered and hot-watched** independent of the (empty) `plugins` array in `opencode.json`; each file is also a watcher target (reload on edit).

---

## 4. Skills `~/.config/opencode/skills/`

```sh
ls -1 ~/.config/opencode/skills/ | wc -l        # → 74
cat -n /tmp/skills.txt                          # full list
grep -nE -- '-(low|medium|high|max|xhigh)$' /tmp/skills.txt
ls -la ~/.config/opencode/skills/brainstorming/  # sample dir
```

- **74 directories**, `du -sh` = 10M, mtime 24 Sep 01:09.
- **No level-suffixed skill directories.** The only name matching a `-(low|medium|high|max|xhigh)$` pattern is `ui-ux-pro-max` (false positive). Level suffixes appear exclusively in `agent.*` names in `opencode.json` (§2).
- Naming conventions observed: `kebab-case` throughout; groupings by vendor (`21st-dev`, `context7-mcp`, `supabase*`), by verb (`create-*`, `update-*`, `migrate-*`, `review*`), by domain (`android-*`, `assignment-writing-*`, `build-mcp*`), and an *average/excellent* sibling pair (`assignment-writing-average`, `assignment-writing-excellent`).

First 20 (in `ls` order):

```
21st-dev, android-emulator-qa, android-performance, api-pr-review,
assignment-writing-average, assignment-writing-excellent, automate, autopilot,
awesome-design, babysit, backend-explorer, backend-flow-extractor, brainstorming,
build-mcp-app, build-mcp-server, build-mcpb, canvas, cli-research-agent,
context7-mcp, create-hook
```

Sample dir layout (`brainstorming/`): `SKILL.md` (10,435 B), `scripts/`, plus auxiliary `.md` files — i.e. **SKILL.md + optional `scripts/` + optional extra markdown**.

---

## 5. Data dir `~/.local/share/opencode/`

```sh
ls -la ~/.local/share/opencode/
du -sh ~/.local/share/opencode/* | sort -h
```

| Entry | Size | Notes |
|---|---|---|
| `opencode.db` | 63M (65,351,680 B) | main SQLite DB |
| `opencode.db-wal` | 644K (593,312 B) | WAL — DB is actively written |
| `opencode.db-shm` | 32K | shared-memory index |
| `log/` | 10M | `opencode.log` = 10,453,271 B |
| `shell/` | 2.3M | shell/tool scratch |
| `snapshot/` | 2.4M | git snapshot stores (bare `--git-dir` per session) |
| `tool-output/` | 276K | tool result spill |
| `account.json` | 8.0K (6,763 B) | §2 |
| `auth.json` | 4.0K (3,766 B) | §2 — credential store |
| `mcp-auth.json` | 445 B | §2 — MCP OAuth state |
| `repos/` | 0B | empty |

### SQLite — opened **read-only**

```sh
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" ".tables"
sqlite3 "file:…?mode=ro" "SELECT COUNT(*) FROM kv;"           # etc.
sqlite3 "file:…?mode=ro" ".schema kv"
sqlite3 "file:…?mode=ro" ".schema session_message"
```

Tables (17): `account  account_state  control_account  credential  event  event_sequence
instruction_blob  instruction_entry  instruction_state  migration  permission  project
project_directory  session_inbox  session_message  session_pending  session_v2  workspace  worktree`
(plus `kv`).

| Table | Rows |
|---|---|
| `kv` | **7** |
| `session_v2` | **76** |
| `session_message` | **4,109** |
| `event` | **0** |
| `permission` | **13** |

`kv` schema (`.schema kv`):

```sql
CREATE TABLE `kv` (
  `key` text PRIMARY KEY,
  `value` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
```

`kv` contents, keys/types only (`SELECT key, typeof(value), length(value) FROM kv`):

| key | value type | length |
|---|---|---|
| `models-dev:catalog` | text | 5,565,837 |
| `websearch:provider` | text | 8 |
| `job.background/msg_…` ×5 | text | ~300 each |

→ **`kv` is a flat `key TEXT PRIMARY KEY / value TEXT` string store with created/updated timestamps.** This is the shape that backs a plugin `ctx.storage` (namespaced string keys, JSON-serializable values). No plugin in §3 currently uses it.

`session_message` schema (`.schema session_message`):

```sql
CREATE TABLE `session_message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `type` text NOT NULL,
  `seq` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  CONSTRAINT `fk_session_message_session_id_session_v2_id_fk`
    FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON (session_id, seq);
CREATE INDEX session_message_session_type_seq_idx    ON (session_id, type, seq);
CREATE INDEX session_message_session_time_created_id_idx ON (session_id, time_created, id);
CREATE INDEX session_message_time_created_idx        ON (time_created);
```

Message `type` distribution (`SELECT type, COUNT(*) … GROUP BY type`):

| type | rows |
|---|---|
| `assistant` | 3,422 |
| `user` | 270 |
| `idle` | 251 |
| `synthetic` | 125 |
| `compaction` | 24 |
| `system` | 20 |
| `model-switched` | 3 |
| `agent-switched` | 1 |

Note the `synthetic` type exists — it is what `ctx.session.synthetic()` (§3) produces.

`session_v2` columns (via `PRAGMA table_info`, informational): `id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory, path, title, version, share_url, summary_*, metadata, cost, tokens_input, tokens_output, …` — i.e. **sessions are hierarchical (`parent_id`), forkable, and carry their own directory + cost accounting.**

---

## 6. Logs `~/.local/share/opencode/log/opencode.log`

```sh
tail -30 ~/.local/share/opencode/log/opencode.log
grep -a "role="   …opencode.log | sort | uniq -c
grep -a "level="  …opencode.log | sort | uniq -c
grep -a "message=" … | sort | uniq -c | sort -rn | head -20
grep -a "role=" …opencode.log | head -5
```

**Line format** (single line per event, space-separated `key=value`, quoted values where the text contains spaces):

```
timestamp=<ISO-8601 ms, UTC "Z"> level=<LEVEL> run=<8-hex> message="<text>" <extra key="…">… role=<role>
```

Examples (normal paths only, no secrets):

```
timestamp=2026-09-25T12:04:17.915Z level=INFO run=bfe8df9c message="cli starting"
  version=2.0.16 channel=latest local=false args=["--help"] role=cli

timestamp=2026-09-25T12:04:07.784Z level=INFO run=0b49606b message="spawning process"
  command=/bin/zsh args="[…]" cwd=/Users/hareeshkarravi/opencode-advisor http.span=3513030 role=server

timestamp=2026-09-25T11:45:35.105Z level=INFO run=0b49606b msg="loading plugin"
  id=~/.config/opencode/plugins/rtk.ts entrypoint=file://… http.span=129 role=server
```

| Field | Shape / observed values |
|---|---|
| `timestamp` | `YYYY-MM-DDTHH:MM:SS.mmmZ` |
| `level` | `INFO` 30,572 · `WARN` 1,190 · `ERROR` 27 |
| `run` | 8-hex run id shared by all lines of one process |
| `message` | **double-quoted** free text — *most* lines; a minority use `msg=` instead (e.g. `msg="loading plugin"`) |
| extras | unquoted bare tokens (`level=`, `component=plugin`, `path=`, `cwd=`, `durationMs=`) or double-quoted tokens (`args="[…]"`, JSON arrays escaped as `\"`) |
| `http.span=` | monotonic span id (present on server-side work) |
| `role=` | `server` 22,740 · `cli` 3,349 |

`role=` samples (`grep -a "role=" | head -5`):

```
message="cli starting" version=2.0.15 … role=cli
message="background service starting" reason=missing previousVersion=undefined role=cli
message="event stream connecting" component=client attempt=0 role=cli
message="plugin reconciliation started" component=plugin id=1 role=cli
message="plugin reconciliation completed" component=plugin id=1 durationMs=6 plugins=12 role=cli
```

→ **`role=cli` = short-lived CLI/foreground process; `role=server` = the long-lived background service (same `run` id for its whole life).** `plugins=12` is the reconciled plugin count reported by the CLI (project + global + built-ins).

Most frequent messages: `spawning process` 15,694 · `watcher subscribe` 5,273 · `plugin reconciliation started/completed` 1,135 each · `watcher started` 851 · `watcher stopped` 805 · `configuration normalization diagnostic` 688 · `event stream connecting/connected` 335 each · `mcp http request failed` 200 · `cli starting` 55.

---

## 7. Commands & rules dirs

```sh
ls -R ~/.config/opencode/commands/ ~/.config/opencode/rules/
```

| Dir | Contents |
|---|---|
| `~/.config/opencode/commands/` | `reload-subagents.md` (1 file) |
| `~/.config/opencode/rules/` | `lean-ctx.md` (1 file) |

Both are single-file directories — names only, per scope.

---

## Facts our advisor plugin can rely on

- **Version baseline: `opencode v2.0.16`**, Bun-compiled Mach-O arm64 at `~/.opencode/bin/opencode` (178,602,224 B), reached through `/usr/local/bin/opencode`; `opencode2` is a 47-byte `exec "$(dirname "$0")/opencode" "$@"` shim, so version/behavior is identical for both entry points.
- **Plugin contract on this install is exclusively `export default { id, async setup(ctx) }`** — no `Plugin.define`, no `server()` export, no V1 named exports in any of the 3 loaded plugins; `~/.config/opencode/plugins/*.ts` is auto-discovered *and* hot-watched even though `plugins: []` in `opencode.json`.
- **Confirmed V2 plugin API surface:** `ctx.tool.hook("execute.before", e => …)` (mutable `event.input`), `ctx.tool.transform(editor => editor.add({name, description, input /* JSON Schema */, execute}))`, `ctx.session.hook("context", …)`, `ctx.session.create/get/prompt/wait/interrupt/context/synthetic`, `ctx.model.list()`, plus `ctx.options` and `ctx.location.directory`.
- **Tool execute context carries `sessionID`, `agent`, `messageID`, `signal` (abort) and `progress`**; tool results accept `{content, metadata}` and metadata is the sanctioned way to return child-session ids (V1 `ctx.metadata()` live publishing is gone).
- **Plugin storage = the `kv` table in `~/.local/share/opencode/opencode.db`**: `key TEXT PRIMARY KEY, value TEXT, time_created, time_updated` — currently 7 rows (largest is `models-dev:catalog` at 5.5 MB); no local plugin uses `ctx.storage` yet, so the surface is free.
- **Session persistence = `session_v2` (76 rows, hierarchical via `parent_id`) + `session_message` (4,109 rows, `type`/`seq`/`data` JSON, FK cascade)**; `type` values include `synthetic`, `compaction`, `model-switched`, `agent-switched` — `ctx.session.synthetic()` writes real `synthetic` message rows.
- **User config mixes V1-shaped keys that V2 normalizes away with WARN** (`configuration normalization diagnostic`, e.g. `$.compaction.prune`, `$.provider.*.models.*.reasoning`) — a plugin should tolerate legacy keys rather than assume strict schema validity.
- **Provider/agent config is data-driven:** 3 providers (`bailian-token-plan`, `meta`, `mimo`; each with `npm` + `options.baseURL` + `options.apiKey` present-but-redacted) and **39 agents, all `mode: "subagent"`, named `<role>-<provider>-<model>[-<effort>]`** — so an advisor can enumerate routable models from `ctx.model.list()` and cross-reference `agent.*` names without parsing prose.
- **Skills live at `~/.config/opencode/skills/` with 74 `kebab-case` dirs (`SKILL.md` + optional `scripts/`); they are NOT level-suffixed** — effort tiers exist only in agent names.
- **Logs are a machine-parseable `timestamp=… level=… run=… message="…" key=value… role=cli|server` stream** (10 MB, ~31.8k lines) where `role=server` marks the long-lived background service — ideal for an advisor to tail for `configuration normalization diagnostic`, `loading plugin`, and `mcp … failed` signals.
