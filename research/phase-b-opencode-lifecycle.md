# Phase B — OpenCode V1 vs. V2 Lifecycle Interception

**Date:** 2026-09-25
**Status:** COMPLETE — official V2 docs + plugin migration guide fetched (source of truth: opencode.ai/v2/docs)
**Scope:** Confirm the raw hook/interceptor definitions exposed by V2 vs V1 core, config schema shapes, and the dual-support packaging pattern.

---

## 1. Verdict

V2's plugin API is **richer than the spec assumed** and is deliberately built for exactly our use case. The killer primitives:

- **`ctx.generate.text({ model, prompt })`** — "Generate text with a selected model **without creating a session, invoking tools, or adding to session history**." This is *literally* the advisor sub-inference primitive, natively read-only.
- **`ctx.tool.transform`** — register the zero-arg `advisor` tool whose result flows back into the executor turn (client-side `advisor_tool_result`).
- **`ctx.session.hook("context")`** — intercept the assembled system/messages/tools/options **immediately before model dispatch** (the runtime-stream interception point; transient — does not mutate persisted history).
- **`ctx.session.hook("retry")`** — roadblock detection on provider failures.
- **`ctx.permission.rules({sessionID, permissions})`** — session-scoped read-only enforcement (`{action:"edit"|"shell", resource:"*", effect:"deny"}`).
- **`ctx.storage`** — durable, plugin-scoped JSON (advisor call counters, usage ledger).

A single package **can officially support both V1 and V2** via one default export exposing both `setup()` (V2) and `server()` (V1, needs OpenCode ≥ 1.18.29).

---

## 2. Config schema shapes (confirmed)

```jsonc
// V1 (opencode.json)
{
  "plugin": [
    "opencode-example-plugin",
    ["./plugin/local.ts", { "enabled": true }]     // package-and-options TUPLE
  ]
}

// V2 (opencode.jsonc)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-example-plugin",
    { "package": "./plugins/local.ts", "options": { "enabled": true } }   // OBJECT form
  ]
}
```

File discovery: V2 reads **both** `.opencode/plugin/` and `.opencode/plugins/`; canonical V2 location is `.opencode/plugins/`. Local plugins and package plugins share the same implementation API. V1 plugin **implementations do not run in V2** (breaking change) — code must be ported or dual-exported.

## 3. Hook / interceptor mapping (V1 → V2)

| V1 extension point | V2 API | Advisor relevance |
|---|---|---|
| `chat.message` | `ctx.session.hook("prompt", ...)` | Reset per-task advisor counter; task-boundary detection |
| `chat.params` | `ctx.session.hook("context", ...)` | Inject timing system prompt; prune outgoing transcript; nudge |
| `chat.headers` | `ctx.session.hook("model.request", ...)` or `"http.request"` | Anthropic pass-through mode: add `anthropic-beta: advisor-tool-2026-03-01` |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` → edit `event.system` | Same as chat.params row |
| `experimental.chat.messages.transform` | `ctx.session.hook("context")` → edit `event.messages` | Prune heavy tool outputs before dispatch |
| `tool.execute.before` / `tool.execute.after` | `ctx.tool.hook("execute.before"/"execute.after", ...)` | Roadblock detection (recurring tool errors) |
| `permission.ask` | `ctx.permission.hook("evaluate", ...)` | Plan-mode guardrail hooks |
| `command.execute.before` | command transforms / prompt hook | `/advisor` command |
| `tool` map | `ctx.tool.transform(...)` | Register the `advisor` tool |
| `provider` | `ctx.provider.transform(...)` + `ctx.model.transform(...)` | Register/route advisor providers |
| `event` | `ctx.event.subscribe()` | Track session lifecycle, usage ledger |
| `dispose` | cleanup fn returned by `setup` | Abort event streams |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)` | Keep advisor context through compaction |
| — (no V1 equivalent) | `ctx.session.hook("retry")` | **New in V2**: roadblock detection on provider failures |
| — (no V1 equivalent) | `ctx.generate.text` | **New in V2**: transient advisor sub-inference |

Hook semantics worth noting:

- `context` hook kinds: `context` (agent loop), `compaction`, `generate`, `title` — register each kind separately if a transform must apply to all model requests.
- `event.options` starts empty per call; typed keys are generation settings; other keys pass through to the selected protocol as provider options; provider option objects merge recursively.
- Provider scoping: third arg `{ providerID: "openai" }` on `ctx.session.hook`.
- `http.request` / `http.response` see the **native provider exchange** (one-shot bodies — clone before reading); `event.kind` ∈ `primary | compaction | title | generate`.
- Experimental WS hooks exist (`experimental.ws.handshake/send/receive`) for streaming providers — not needed for v1 of our plugin.

## 4. Dual-support packaging (official pattern, verbatim shape)

```ts
// One default export; V1 calls server(), V2 calls setup().
export default {
  ...Plugin.define({
    id: "example",
    async setup(ctx) { /* V2 impl */ },
  }),
  async server() {
    return { /* V1 hooks map */ }
  },
}
```

- V1 object entrypoints: supported in OpenCode **1.18.29+**. For older V1 → separate package versions/entrypoints.
- Packages: V1 `@opencode-ai/plugin`, V2 `@opencode/plugin`. Keep V1 types structural/local to avoid a hard dependency.

## 5. Entry point / context deltas

| V1 | V2 |
|---|---|
| `export const Plugin: Plugin = async ({ directory, project, client }) => ({...})` | `export default Plugin.define({ id, setup(ctx) })` |
| options arg in plugin input | `ctx.options` |
| returned `dispose()` | cleanup returned by `setup` |
| `$` Bun shell helper | manage process API yourself |
| `client.*` | domain methods: `ctx.session`, `ctx.permission`, `ctx.agent`, `ctx.tool`, `ctx.provider`, `ctx.model`, `ctx.storage`, `ctx.event`, … |

**Stable plugin `id` is mandatory in V2** (scops storage + diagnostics).

## 6. Permissions enforcement (confirmed shapes)

```jsonc
// V1: grouped by tool
{ "permission": { "bash": { "git push *": "ask" }, "edit": "allow" } }

// V2: ordered array, last matching rule wins
{ "permissions": [
    { "action": "shell",    "resource": "git push *", "effect": "ask" },
    { "action": "edit",     "resource": "*",          "effect": "allow" },
    { "action": "websearch","resource": "*",          "effect": "deny" }
] }
```

Action renames: `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`. Session-scoped runtime replacement (what our plan-mode guardrail uses):

```ts
await ctx.permission.rules({
  sessionID,
  permissions: [
    { action: "edit",  resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ],
})
```

Child sessions inherit rules in effect at creation.

## 7. Spec §4.1 matrix — verified / corrected

| Spec claim | Finding |
|---|---|
| V1 `"plugin": ["oc-advisor"]` vs V2 `"plugins": [{"package":"..."}]` | ✅ Confirmed (tuple → object; options move into `options`) |
| V1 `.opencode/plugin/` vs V2 `.opencode/plugins/` | ✅ Confirmed (V2 discovers **both**; canonical is plural) |
| V2 permissions `{ "action":"shell", "effect":"deny" }` | ⚠️ Corrected — `resource` is part of the rule shape (`"*"` for global) |
| V1 "string-based prompt wrapping" for read-only | ⚠️ Refined — V1 exposes `experimental.chat.system.transform` (structured hook), not just string wrapping; V2 additionally has hard `permission.rules` |
| V1 "manual append to global conversation array" | ⚠️ Refined — V1 `chat.message` / `experimental.chat.messages.transform` hooks exist; V2's `context` hook is transient (never mutates persisted history) which is *better* for nudges |
| V2 "context-isolated subagents via AGENTS.md" | ⚠️ Refined — isolation comes from the session/agent model + `ctx.generate.text` (no session at all), not from AGENTS.md per se |

## 8. Environment detection strategy

No runtime probing needed: in the dual-export pattern **the host picks the entry** (`setup()` on V2, `server()` on V1). Detection reduces to "which method got called." Shared engine code is pure TypeScript (no host imports) and receives an adapter interface:

```ts
interface HostAdapter {
  getTranscript(sessionID: string): Promise<TranscriptEntry[]>
  runAdvisor(prompt: string): Promise<{ text: string; tokens?: number }>
  ledger: { read(k: string): Promise<Json|undefined>; write(k: string, v: Json): Promise<void> }
  log(level: "debug"|"info"|"warn"|"error", msg: string, data?: unknown): void
}
```

- V2 adapter: `ctx.session.context` / `ctx.generate.text` / `ctx.storage` / `console`
- V1 adapter: `client.session.*` (messages read) / direct provider `fetch` (advisor sub-call) / in-memory + JSON file ledger / `client.app.log`

## 9. Sources

- https://opencode.ai/v2/docs/build/plugins (plugin API, context, tools, generate.text, session hooks incl. `context`/`retry`/`http.*`, permissions, storage)
- https://opencode.ai/v2/docs/build/plugins/migrate-v1 (V1↔V2 hook map, entrypoint delta, dual-support pattern, tuple→object config)
- https://opencode.ai/v2/docs/migrate-v1 (config-wide V1→V2 renames, permissions array, plugin path discovery)
- Skill: OpenCode (version policy — V2 docs are source of truth; V1 consulted only as migration input)
