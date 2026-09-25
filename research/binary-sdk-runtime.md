# Binary & SDK Runtime Archaeology — OpenCode v2.0.16 (macOS arm64)

Runtime under test: `~/.opencode/bin/opencode` (178 MB Bun-compiled Mach-O).
Version confirmed: `~/.opencode/bin/opencode --version` → `opencode v2.0.16`
(`~/.opencode/bin/opencode2` is a 3-line `exec` shim to the same binary.)

Method note: the `@opencode/*` domain `.js` files in the plugin package are empty
re-export stubs; the real host implementation for hooks/storage/tools/commands is
Bun-compiled into the binary. Binary claims below were produced by targeted
`strings -n 10 > /private/.../oc-strings.txt` then `grep -boE '<literal>'` to get a
byte offset, then `dd if=oc-strings.txt bs=1 skip=<off-…> count=…` to slice the
minified source. Offsets are quoted per claim.

Runtime JS inspected:
- `/Users/hareeshkarravi/opencode-advisor/node_modules/@opencode/plugin/dist/promise/adapter.js` (26 KB — the only substantive runtime JS; `effect/*.js` and `promise/{session,tool,storage,command}.js` are 0-byte stubs)
- `/Users/hareeshkarravi/opencode-advisor/node_modules/@opencode/protocol/dist/groups/{generate,session,command}.js`
- `/Users/hareeshkarravi/opencode-advisor/node_modules/@opencode/plugin/dist/effect/{session,tool,storage,command}.d.ts`
- `/Users/hareeshkarravi/opencode-advisor/node_modules/@opencode/schema/dist/tool.d.ts`
- Secondary install: `~/.opencode/node_modules/@opencode-ai/plugin@1.18.32` (v1 SDK, distinct)

---

## Target 1 — Binary strings (~/.opencode/bin/opencode)

Commands (exact):
```
strings -n 12 ~/.opencode/bin/opencode | grep -i "subagent" | head -30
strings -n 12 ~/.opencode/bin/opencode | grep -i "advisor"  | head -20
strings -n 20 ~/.opencode/bin/opencode | grep -iE "autoinvoke|delegate.*task|launch.*subagent" | head -20
strings -n 10 ~/.opencode/bin/opencode | grep -iE "http\.request|model\.request|session\.hook" | head -20
```

### 1a. Built-in subagent/task tool identity & descriptions (verbatim)
```
Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)
Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents.
Maximum subagent nesting depth. Defaults to 1.
subagent_depth
Deprecated alias for subagent.
stream.subagent
running subagent
subagent_type
opencode.tool.subagent
SubagentTool.Plugin
The `subagent` tool takes `agent` instead of `subagent_type` and `sessionID` instead of `task_id`.
Subagent completed without a text response.
```
Parameter descriptions of the built-in task tool (verbatim, injected into the model tool schema):
```
The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.
The task for the subagent to perform
Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.
Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.
The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.
Foreground (default) runs the subagent to completion and returns its final response.
NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" ...
```
Implementation symbol found in the binary: `SubagentTool.Plugin` / `SubagentTool.resolveModel`
(`grep -oE 'l\("SubagentTool.resolveModel"\)'`).
There are two tools: the native `subagent` tool (`opencode.tool.subagent`, params `agent` +
`sessionID`) and the `task`-style alias that uses `subagent_type` + `task_id`; the alias note
above is the migration hint emitted to models.

### 1b. Default-agent delegation prompt fragments (verbatim)
Found via `grep -oE 'proactively use the .subagent. tool...'`:
```
- You should proactively use the `subagent` tool to launch specialized subagents when the task at hand can be easily split up into multiple parallel workers.
- If the user's prompt itself says multiple areas, components, or workstreams are independent, launch subagents via the `subagent` tool to tackle the task.
```
Other coordination text: `DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.`
The `subagent_depth` string is the agent-config key for max nesting; default `1` (subagents cannot launch subagents).

### 1c. `advisor`
`strings -n 12 ... | grep -i "advisor"` matched only Bun/npm security-audit boilerplate
(`No advisories found`, `InvalidAdvisoriesFormat`, `Security advisory at index …`) — **no built-in
`advisor` agent, plugin or tool exists in the binary.** Advisor functionality is user-supplied
(the `opencode-advisor` repo / `~/.config/opencode/plugins`).

### 1d. session.hook registrations present in the shipped binary
`grep -oE 'session\.hook\("(context|compaction|generate|prompt|title)"' | sort | uniq -c`:
```
9 session.hook("context"
8 session.hook("compaction"
8 session.hook("generate"
```
Built-in plugins (identity, websearch, instructions, etc.) register these hooks.
Session hook surface (from `@opencode/plugin/dist/effect/session.d.ts`):
`prompt, context, compaction, generate, title, model.request, http.request, http.response,
experimental.ws.handshake, experimental.ws.send, experimental.ws.receive, retry`.

### 1e. Hook dispatch reality (verbatim slice)
`grep -boE 's\("context",c\.agent' oc-strings.txt` → slice:
```js
s=(c,y)=>(u,f)=>e.trigger("session",c,{...u,agent:y,tools:f});
return vT.of({
  primary:(c)=>i("primary",c,s("context",c.agent)),
  compaction:(c)=>i("compaction",c,s("compaction",c.agent)),
  generate:(c)=>i("generate",c,s("generate",c.agent)),
  title:(c)=>i("title",c,(y)=>e.trigger("session","title",y))
})
```
So the internal `SessionRequestKind` (declared verbatim in `session.d.ts`):
```ts
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate";
```
Dispatch mapping: `primary → context`, `compaction → compaction`, `generate → generate`,
`title → title`.

### 1f. `trigger` / `has` inventory (binary)
`grep -oE 'trigger\("session","[a-z.]+"' | sort | uniq -c`:
```
trigger("session","experimental.ws.handshake"
trigger("session","experimental.ws.receive"
trigger("session","experimental.ws.send"
trigger("session","http.request"
trigger("session","http.response"
trigger("session","model.request"
trigger("session","prompt"
trigger("session","retry"
trigger("session","title"
```
`grep -oE 'has\("session","[a-z.]+"'` returns only:
```
has("session","http.request"      (with providerID argument)
has("session","http.response"     (with providerID argument)
```

---

## Target 2 — SDK runtime JS behaviour

### Q1. `generate.text` vs `session.generate` — exact endpoints & forwarded params

`@opencode/protocol/dist/groups/generate.js` (verbatim):
```js
HttpApiEndpoint.post("generate.text", "/api/experimental/generate", {
  payload: Schema.Struct({ prompt: Schema.String, model: Model.Ref.pipe(Schema.optional) }),
  success: Schema.Struct({ data: Schema.Struct({ text: Schema.String }) }) ...
```
`@opencode/protocol/dist/groups/session.js:504` (verbatim):
```js
HttpApiEndpoint.post("session.generate", "/api/session/:sessionID/generate", {
  params: { sessionID: Session.ID },
  payload: Schema.Struct({ prompt: Schema.String }),
  success: Schema.Struct({ data: Schema.Struct({ text: Schema.String }) }) ...
}).middleware(sessionLocationMiddleware)
```
Generated HTTP client (`client/dist/... `; observed in strings slice):
```js
generate:{text:(e,n)=>t({method:"POST",path:"/api/experimental/generate",body:{prompt:e.prompt,model:e.model},successStatus:200,declaredStatuses:[400,...]})}
```
Parameters forwarded:
- `generate.text`: body is exactly `{ prompt, model? }`. No session, no session middleware.
- `session.generate`: path param `sessionID` + body `{ prompt }`; the group carries
  `sessionLocationMiddleware` → session/location-scoped headers are attached to this call.
- Plugin adapter (`adapter.js`, `adaptApiMethod`): input is round-tripped through JSON
  (`Schema.encodeUnknownEffect(JsonInput)` then decode) before endpoint decoding, matching the
  generated Promise client. `generate.text` runs via `Effect.runPromiseWith(runtime)` with **no
  AbortSignal**; by contrast tool `execute` is invoked through `promiseExecutor`, which passes
  `{ signal: context.signal }`.
- `SessionGenerateInput` (generated types) = `{ sessionID, prompt }`; output = `{ data: { text } }`.

### Q2. `ctx.session.hook("http.request")` — dispatch realities
Verbatim binary slice (offset 27761830, `dd` around `trigger("session","http.request"`):
```js
let ne=(yield*e.has("session","http.request",A.ref.providerID))||(yield*e.has("session","http.response",A.ref.providerID))
  ?(ge,Ee)=>d(function*(){
      let ce=yield*e.trigger("session","http.request",{...p,request:yield*$F(ge)}),Ce=dI(ce.request);
      if(ce.request.body)Ce=g5(Ce,new Uint8Array(yield*re(()=>ce.request.clone().arrayBuffer())),ce.request.headers.get("content-type")??void 0);
      let Ie=yield*Ee(Ce),Xe=yield*e.trigger("session","http.response",{...p,request:ce.request,response:new Response(...)});
```
Facts:
- `http.request` is fired **only if a plugin registered a hook for that provider** — guarded by
  `has("session","http.request", providerID)` (and the same for `http.response`). If no plugin
  registers it, the whole wrapper is skipped (zero overhead).
- It is dispatched inside the **session model driver** (the `fr.update(...model...)` fetch path),
  receiving `{ sessionID, agent, model, kind, request: Request }` (see `SessionHttpRequest` in
  `session.d.ts`), and the plugin may replace `request`. `kind` is one of
  `primary | compaction | title | generate`.
- `generate.text` handler (binary): `e.handle("generate.text", ... { text: yield* (yield*$1).text(s.payload) ... })`
  where `$1` is the stateless `Generate` service (`l("Generate.text")`), and the route has no
  `sessionID`/session middleware. **INFERRED (not definitive):** `generate.text` therefore does not
  fire the session-scoped `http.request`/`model.request` hooks, because those hooks are triggered
  only in the session model driver and require a session + provider scope.
  `session.generate` handler calls `o.generate({sessionID, prompt})` (SessionApi), i.e. it runs
  through the session driver, so it **does** fire them. The definitive, source-backed fact is the
  `has("session","http.request",providerID)` gating above.

### Q3. `ctx.tool.transform` / `editor.add` — `options.permission` and `options.namespace`
Type source: `@opencode/schema/dist/tool.d.ts`
```ts
interface BaseOptions { readonly namespace?: string; readonly permission?: string; }
export type Options = BaseOptions & ({ codemode?: true; pinned?: boolean } | { codemode: boolean; pinned?: never });
```
`@opencode/plugin/dist/effect/tool.d.ts`:
```ts
namespace(namespace: Tool.Namespace): void;                 // editor default namespace
add<...>(tool: Tool.Info<Input, Output>): void;             // per-tool options carry namespace/permission
```
Runtime (verbatim binary slices):
```js
// exposed tool name composition
options?.namespace===void 0 ? ti(e) : `${e.options.namespace.replaceAll(".","_")}_${ti(e)}`
namespace.replaceAll(".","_")}_${J.name}`   // → o.exposedToolName=q
// editor namespace setter
namespace:(y)=>{let f=al(y.name); ... }
```
- `options.namespace` present → exposed tool id/name becomes
  `${namespace.replaceAll(".","_")}_${toolName}`; absent → just `toolName`.
- `editor.namespace({name, description})` stores a default namespace (`al(name)`) applied to
  subsequently added tools.
- `options.permission` default (verbatim binary slice at offset 27460673, in `Tool.snapshot`):
```js
snapshot:((p)=>{let y=u.get(),f=new Map,h=p??[];
  for(let[H,X]of y.tools){ if(ol(X.options?.permission??H,h)) continue; f.set(H,X) }
  ...})
```
  i.e. **when `options.permission` is omitted the permission key defaults to the exposed tool name
  `H` (namespace-prefixed)**; that resolved key is matched against the permission list `h`.
  `ol(...)` is the allow/deny predicate.
- The promise adapter wraps `editor.add` so the JS `execute(input)` is lifted into Effect:
```js
add:(tool)=>editor.add({ ...tool, execute:(input,context)=>executePromiseTool(tool,input,context) })
```

### Q4. `ctx.storage` backing
Binary slices (verbatim):
```js
KV.get")(function*(o){ return (yield*e.select({value:La.value}).from(La).where(Z(La.key,o)).get()...})
KV.set")(function*(o,T){ yield*e.insert(La).values({key:o,value:T}).onConflictDoUpdate({target:La....
KV.remove")(function*(o){ yield*e.delete(La).where(Z(La.key,o)).run()...})
scan:l("KV.scan")(function*(o){ let T=Number.isNaN(o.limit)?100:Math.min(Math.max(Math.floor(o.limit??100),1),1000), i=vm(o.prefix...
```
Table definition (verbatim): `"kv",{key:Tt().primaryKey(),value:Tt({mode:"json"...`
Also present: the literal `"kv.json"` (2×) — a JSON-file mirror/persistence artifact.
Plugin namespacing (verbatim): `storage.store(\`plugin.${t.id}.${g}\`,b), memory:(g,b)=>r.storage.memory(\`plugin.${t.id}.${g}\`,b)`
- Backing store = a **SQL KV table named `kv`** with `key` (text, primary key) and `value` (JSON),
  upserted via `onConflictDoUpdate`; also a `kv.json` file artifact.
- `ctx.storage.{get,set,remove,scan}` (Effect domain, `plugin/dist/effect/storage.d.ts`) are
  namespaced per plugin as **`plugin.<pluginId>.<userKey>`**, for both persistent `store` and
  `memory` variants.
- `scan` options: `{ prefix, after?, limit? }`; limit is clamped to `1..1000`, default `100`.
  `StorageScanResult` = `{ entries, next? }`.

### Q5. `ctx.command.transform` — how registered commands surface
Type source `plugin/dist/effect/command.d.ts`:
```ts
export interface CommandDefinition { readonly name: string; readonly description?: string;
  readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>; }
export interface CommandEditor { add(definition: CommandDefinition): void; }
```
Runtime:
- Adapter (`adapter.js`): `command:{ list: adaptApiMethod(CommandEndpoints["command.list"], host.command.list),
  transform:(cb)=>register(host.command.transform((editor)=>cb({ add:(definition)=>editor.add({...definition, execute:(input)=>Effect.tryPromise(...)}) }))), reload:... }`
- Config-defined commands are registered by a built-in transform (verbatim binary slice, offset 28236643):
```js
command.transform((q)=>{ for(let H of w.documents) for(let[Q,I]of Object.entries(H.commands??{})){
  let Y=I.subagent??I.subtask;
  q.add({name:Q, description:I.description, execute:(oe)=>d(function*(){ let J=I.agent===void 0?void 0:Cu.make(I.agent), ie=...
    let ee=yield*iL(I.template,oe.prompt.text,{location:s,processes:c,shell:p});
    if(Y??ie?.mode==="subagent"){let pe=yield*f.get(oe.sessionID), _e=yield*A.select(J??pe.agent), ce=yield*f.create({parentID:pe.id,title:I.description??Q,agent:_e.id,model:...})
```
  i.e. `opencode.json` `command.<name>` entries (fields: `description`, `template`, `agent`,
  `model`, `subagent`/`subtask`) become commands; if `subagent` (alias `subtask`) is set, or the
  target agent's `mode === "subagent"`, the command forks a child session.
- A built-in command is also added the same way: `command.transform((c)=>{c.add({name:"init",description:"guided AGENTS.md setup",execute:...})})`.
- Surfacing: listed through `GET /api/command` (`command.list`, returns `Command.Info[]` where
  `Info = { name, description? }`), and rendered in the TUI as slash entries. Verbatim TUI slice:
  `he.push({display:"/"+at.name, description:at.description, queueable:!0, onSelect:...`
- Invocation path: `POST /api/session/:sessionID/command` with payload
  `{ name: string, ...PromptInput.Prompt.fields, delivery? }`, `204 No Content`; the group is
  wrapped in `sessionLocationMiddleware` and errors are `SessionNotFound | CommandNotFound |
  CommandExecution`. This endpoint is created by default (from the schema's built-in) and plugins
  add definitions via `transform`.

---

## NATIVE TRIGGERING FACTS

- Built-in subagent tool id is `opencode.tool.subagent` (`SubagentTool.Plugin`), with params `agent` + `sessionID`; the `task`-style alias uses `subagent_type` + `task_id`, and the binary emits "The `subagent` tool takes `agent` instead of `subagent_type` and `sessionID` instead of `task_id`." — source: binary grep (Target 1a).
- Default subagent nesting depth is `1` and it "prevents subagents from launching subagents"; config key `subagent_depth` — source: binary grep (Target 1a).
- The shipped default-agent system prompt contains proactive-delegation bullets ("You should proactively use the `subagent` tool…" / "If the user's prompt itself says multiple areas… launch subagents via the `subagent` tool…") — source: binary grep (Target 1b).
- Session request kinds are exactly `primary | compaction | title | generate`; dispatch maps `primary→context`, `compaction→compaction`, `generate→generate`, `title→title` — source: `plugin/dist/effect/session.d.ts` + binary byte-slice (Target 1e).
- `session.hook("http.request"/"http.response")` is **gated** by `has("session", <name>, providerID)`; the wrapper (and thus the trigger) only exists when a plugin registered that hook for the provider — source: binary byte-slice offset 27761830 (Target 1f).
- `http.request`/`model.request` carry `kind`, so plugin hooks can distinguish the agent loop (`primary`) from `compaction`/`title`/`generate` requests — source: `session.d.ts` `SessionRequestKind` + dispatch slice (Target 1e/2-Q2).
- `generate.text` = stateless `POST /api/experimental/generate` body `{prompt, model?}`, no session middleware, served by `l("Generate.text")`; `session.generate` = `POST /api/session/:sessionID/generate` body `{prompt}`, `sessionLocationMiddleware`, served by SessionApi — source: `protocol/dist/groups/{generate,session}.js` + binary handler slices (Target 2-Q1).
- INFERRED: because `generate.text` has no session and runs the stateless `Generate` service, it does **not** fire session-scoped `http.request`/`model.request`; `session.generate` does (it calls SessionApi `generate`). Definitive fact remains the provider-scoped `has(...)` gating — source: binary slices (Target 2-Q2).
- `ctx.storage` is backed by SQL table `kv` (`key` text PK, `value` JSON, upsert) plus a `kv.json` artifact; plugin keys are namespaced `plugin.<pluginId>.<key>`; `scan` clamps limit to 1–1000 (default 100) — source: binary slices (Target 2-Q4).
- `ctx.tool.transform` `editor.add` `options.permission`, when omitted, resolves to the **exposed tool name**; `options.namespace` composes the exposed name as `${namespace.replaceAll(".","_")}_${toolName}` — source: binary byte-slices offsets 27460673 / namespace slice (Target 2-Q3).
- `ctx.command.transform` definitions surface as slash commands listed by `GET /api/command` and invoked by `POST /api/session/:sessionID/command`; config `command.*` entries (with `subagent`/`subtask`) can fork child sessions — source: `protocol/dist/groups/{command,session}.js`, TUI binary slice, config-transform slice (Target 2-Q5).
- No built-in `advisor` tool/agent/plugin exists in the binary; the only "advisor" string hits are npm security-audit boilerplate — source: `strings … | grep -i advisor` (Target 1c).
- SDK package domain `.js` files are empty re-export stubs; the only substantive plugin runtime JS is `@opencode/plugin/dist/promise/adapter.js`, and `adaptApiMethod` JSON-normalizes inputs before endpoint decoding (matching the generated Promise client) — source: file listing + adapter.js (Target 2 intro / Q1).
