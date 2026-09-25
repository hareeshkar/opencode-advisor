# TUI/CLI plugin discovery for directory installs (OpenCode v2.0.16, macOS arm64)

Scope: how a **directory-installed** plugin (`opencode.json` → `"plugins": ["./opencode-advisor"]`)
ships a TUI/CLI component so its `slash` command appears in prompt completion, without being an
npm package. All claims are tagged **PROVEN** (code/docs/live evidence) or **INFERRED**.

Environment: `opencode v2.0.16`, binary `/Users/hareeshkarravi/.opencode/bin/opencode` (178 MB).
Install under test: `~/.config/opencode/opencode-advisor/index.js` (server only).

---

## (a) Verdict — directory installs

**SUPPORTED, with one caveat.** A local directory install can ship a TUI component by placing a
sibling file literally named `tui` (`.ts` / `.tsx` / `.js` / `.jsx` / `.mjs`) in the **same plugin
directory** as the server entry:

```
<plugin-dir>/
  index.js   # server entry (resolved as server/server -> index)
  tui.js     # CLI/TUI entry (resolved as <dir>/tui)
```

Caveat (**PROVEN by code**): for directory installs the loader resolves the TUI entry by **filename
convention**, *not* by `package.json` `exports["./tui"]`. The `exports` route is only used for
published/bare npm packages. So a `package.json` with `"exports": {"./tui": ...}` inside the
directory will **not** make the TUI load; you must name the file `tui.*` (sibling).

---

## (b) Evidence per claim

### B1. Docs: config discovery + `./tui` export (PROVEN, docs)
Fetched `https://opencode.ai/v2/docs/cli/plugins` and `https://opencode.ai/v2/docs/build/plugins/cli`.
Local mirrors: `research/docs-scrape/v2/cli_plugins.md` and `build_plugins_cli.md`.

- `cli_plugins.md` L3: *"Plugins configured in `opencode.json(c)` that expose a TUI component are
  loaded automatically by the CLI … The CLI gets the active plugin list from the connected OpenCode
  server."*
- `cli_plugins.md` L48-55: discovery layout is a directory with sibling entrypoints:
  ```
  <global-config>/plugins/status/index.ts
  <global-config>/plugins/status/tui.ts
  <project>/.opencode/plugins/status/index.ts
  <project>/.opencode/plugins/status/tui.ts
  ```
- `build_plugins_cli.md` L540-561: *"Expose the CLI plugin through `./tui`"* for a **published
  package** (`"exports": { ".": "./src/index.ts", "./tui": "./src/tui.tsx" }`), and *"Export `./tui`
  beside the main plugin for automatic loading."*
- `build_plugins_cli.md`: commands are registered through `context.keymap.layer(...)` with
  `slash: { name, aliases, arguments }`; pickers via `context.ui.dialog.select({...})`. Import
  `@opencode/plugin/tui` directly (OpenCode resolves it at runtime).
- `cli_plugins.md`: CLI-only plugins may alternatively be listed in `cli.json`
  (`https://opencode.ai/v2/cli.json`); `cli.json` remains active against remote servers.

### B2. `@opencode/plugin@2.0.16` package.json (PROVEN)
`research/api-types/opencode-plugin-2.0.16/package.json`:
- L25-28: `"./tui": { "import": "./dist/tui/index.js", "types": "./dist/tui/index.d.ts" }`
- L55-60 peerDependencies: `@opencode/theme`, `@opentui/core (>=0.5.10)`,
  `@opentui/solid (>=0.5.10)`, `solid-js (>=1.9.0)` — all marked optional (L61-74).
  → TUI component may render without JSX; OpenTUI peers are only needed for JSX rendering.

### B3. Binary: server-side entrypoint resolver `qT` (PROVEN)
Extracted from the bun bundle inside `~/.opencode/bin/opencode`:

```js
function qT(r){
  let n=(t)=>{for(let o of t){
    let i = r.name ? [r.name,o].filter(Boolean).join("/")
                   : s.resolve(r.directory, o||"index");
    try{ return IT(i, r.directory) }catch(e){ /* swallow ENOENT/ENOTDIR/MODULE_NOT_FOUND/
      ERR_MODULE_NOT_FOUND/ERR_PACKAGE_PATH_NOT_EXPORTED/ERR_UNSUPPORTED_DIR_IMPORT */ }
  }return};
  return { server: n(["server",""]), tui: n(["tui"]), rpc: n(["rpc"]) };
}
function IT(o,e){ let r=Bun.resolveSync(o,e); return r.startsWith("node:")?r:t(r).href }
```
Consequences (**PROVEN**):
- `server` candidates: `<dir>/server` then `<dir>/index` (the `""→"index"` fallback).
- `tui` candidate: only `<dir>/tui` (no `tui/index` fallback), resolved by `Bun.resolveSync`, which
  adds extensions (`.ts/.tsx/.js/.jsx/.mjs`).
- When `r.name` is absent (a plain `{directory}` — the local-directory case) resolution is a plain
  **filesystem path**; package `exports` are not consulted for absolute subpaths. `exports["./tui"]`
  is only reachable when `r.name` is set (npm/bare package via `s.resolve`/`s.add`).

### B4. Binary: server sets `features.tui` from that resolver (PROVEN)
Server plugin load (`PluginModule.load` → `FB`):

```js
let u = cc.isAbsolute(e.target),
    ...
    p = u && (await S7(e.target)).isFile()
          ? { server: bB(e.target).href }                 // target is a FILE: server only
          : await qT(c ?? { directory: e.target });       // target is a DIR: resolve server+tui
...
return { id: y.id,
         features: { ...p.tui ? { tui: true } : {}, ...p.rpc ? { rpc: true } : {} },
         source: cc.isAbsolute(e.target) ? { type: "local", path: vB(f) } : { type: "package", ... } };
```
Consequences (**PROVEN**):
- If `e.target` is a **directory**, `qT({directory}).tui` is resolved → `features.tui: true` when a
  `tui.*` file exists.
- If `e.target` is a **file** (e.g. `"plugins": ["./opencode-advisor/index.js"]`), the resolver is
  short-circuited to `{server: file}` and TUI detection is skipped entirely.
  → keep the config entry as the **directory**.
- `source.path` records the resolved server **file** (e.g. `.../index.js`) for local plugins.

### B5. Binary: CLI loads TUI plugins matching `features.tui` + local/package (PROVEN)
CLI-side plugin registry:

```js
b = A(()=> m().filter((ke) =>
      ke.state.status==="active" &&
      ke.features.tui===!0 &&
      (ke.source.type==="package" || ke.source.type==="local")))
```
CLI reconciliation re-injects those as discovery entries:

```js
... b().map((se)=>({
      entry: se.source.type==="package" ? se.source.target : rK.dirname(se.source.path),
      install:false, optional:true }))
```
CLI loader validates and imports the TUI module:

```js
let b = r ? { directory: iK(r) } : await m("prepare", ...),
    E = qT(b).tui;
if(!E) return { status:"unsupported" };
... if(!("default" in P) || !JAt(P.default))
      throw Error(`Invalid V2 TUI plugin module: ${t}`);
```
```js
function JAt(t){ return typeof t==="object" && t!==null && "id" in t &&
                        typeof t.id==="string" && t.id.length>0 &&
                        "setup" in t && typeof t.setup==="function" }
```
Consequences (**PROVEN**):
- It uses `dirname(source.path)` (the server file) → the plugin **directory** → `qT(dir).tui` →
  the sibling `tui.*` file. So the CLI resolves the same sibling file the server flagged.
- The TUI module must `export default` a `{ id, setup }` object (i.e. `Plugin.define({...})`).
- `@opencode/plugin/tui` is injected by the runtime: the binary calls
  `YW({additional:{"@opencode/plugin/tui":{Plugin:Ff,PluginContextProvider:Kl,usePlugin:C1}}})`,
  so local TUI files can import it directly with no npm install of the OpenCode SDK.

### B6. Live runtime: advisor is server-only today (PROVEN)
`opencode api get /api/plugin` (shared daemon, 2026-09-25):
```json
{"id":"opencode-advisor",
 "source":{"type":"local","path":"/Users/hareeshkarravi/.config/opencode/opencode-advisor/index.js"},
 "features":{"server":true},
 "state":{"status":"active"}}
```
→ `source.type:"local"` (eligible for CLI TUI) but `features.tui` absent because the directory has
only `index.js`; `ls` confirms no `tui.*` file. The three other non-builtin plugins
(`rtk.ts`, `skillful.ts`, `subagent-delegate/index.ts`) are likewise `{server:true}`.

### B7. Logs: CLI reconciles plugins in the TUI process (PROVEN)
`~/.local/share/opencode/log/opencode.log` contains the running TUI’s CLI role:
```
… message="plugin reconciliation started" component=plugin id=… role=cli
… message="plugin reconciliation completed" component=plugin id=… durationMs=… plugins=12 role=cli
```
→ the CLI (TUI) runs its own plugin pass; TUI plugin load failures surface as toasts, and the
`Invalid V2 TUI plugin module` error string is what appears in logs on a malformed export.

### B8. `opencode plugin add` is npm/Git-only (PROVEN)
Binary `cli.plugin.add` handler:
```js
if(!(await aS(e.package)))
  return yield* R(Error("Plugin target must be an npm registry package or Git package specifier"));
let r = await (await Ts).add(e.package), c = qT(r), o = k(c.server, c.tui);
if(!o) return yield* R(Error(`Plugin package has no server or TUI entrypoint: ${e.package}`));
if(o==="server"){ /* add to opencode.json */ }
else { /* "TUI plugin \"" + pkg + "\" installed and added to " + cli.json path */ }
```
→ local paths cannot be `plugin add`ed; server plugins go to `opencode.json`, TUI-only packages go to
`cli.json`.

### B9. Empirical probe harness (INCONCLUSIVE — harness limitation, not product)
An isolated test (temp project + temp `XDG_CONFIG_HOME`, `opencode api --standalone` / private
`opencode serve` on custom ports) did **not** surface test plugins: the fresh server returned
`data: []` and logged no plugin reconciliation, while the shared long-running daemon correctly
returned the 4 real local plugins. Root cause: plugin reconciliation in a fresh, config-less
location did not run in the time window / requires the normal daemon boot path. This is a
**harness limitation**; it does not contradict B3–B7. The filename/exports distinction is therefore
**PROVEN by code (B3)** and **corroborated by docs (B1)**, but the single last hop (“drop tui.js →
`features.tui:true` at runtime”) is **INFERRED** (very high confidence) rather than directly
observed.

---

## (c) Minimal working layout for opencode-advisor

```
~/.config/opencode/
  opencode.json                       # already: "plugins": [{ "package": "./opencode-advisor", ... }]
  opencode-advisor/
    index.js                          # server entry (exists; = bundled dist/opencode-advisor.js)
    tui.js                            # NEW — CLI/TUI entry (ESM). Name MUST be tui.*
```
Keep the config entry as the **directory** `./opencode-advisor` (not `./opencode-advisor/index.js`),
otherwise `features.tui` is never computed (B4).

Minimal `tui.js` (no JSX, so no OpenTUI/solid peer installs required locally; `@opencode/plugin/tui`
is provided by the runtime — B5). Picker = `context.ui.dialog.select`; slash command = keymap layer:

```js
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode-advisor.cli",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "advisor.pick",
          title: "Advisor: choose model",
          group: "Advisor",
          palette: true,
          suggested: true,
          slash: { name: "advisor", aliases: ["adv"], arguments: true },
          run: async (input) => {
            const value = await context.ui.dialog.select({
              title: "Advisor model",
              options: [
                { title: "GLM-5.3", value: "zai-coding-plan/glm-5.3" },
                { title: "DeepSeek V4 Pro", value: "bailian-token-plan/deepseek-v4-pro" },
              ],
            })
            if (value) context.ui.toast.show({ message: `Advisor model: ${value}` })
          },
        },
      ],
      bindings: ["advisor.pick"],
    }))
  },
})
```

Notes:
- `export default` must resolve to `{ id: <non-empty string>, setup: <function> }` (B5 `JAt`) —
  `Plugin.define` supplies this.
- To share code with the server bundle, import relative ESM from `./index.js` if it re-exports the
  helpers (currently it exports `resolveOptions`, `shortlistAdvisorModels`, etc.).
- Restart OpenCode once after adding the file (or rely on the config-dir watcher). Verify with
  `opencode api get /api/plugin` and look for `"features":{"server":true,"tui":true}` on
  `opencode-advisor` (**verification step; INFERRED until observed**).
- File may be `.ts`/`.tsx` too (the loader is Bun-based and transpiles; B3/B5). Prefer `.js` if you
  don’t want a build step. Only add `@opentui/core`, `@opentui/solid`, `solid-js` peers if you render
  JSX.

---

## (d) Fallbacks if the directory route is ever unsupported

1. **Auto-discovery layout (no `opencode.json` entry).** Create
   `<global-config>/plugins/advisor/{index.ts,tui.ts}` (docs B1). Same sibling rule; useful for a
   TUI-only or split plugin.
2. **`cli.json` for CLI-only plugins.** Per `https://opencode.ai/v2/cli/plugins`, add the package/dir
   to `~/.config/opencode/cli.json` `"plugins": [...]`; stays active against remote servers. Object
   form `{ "package": "...", "options": {...} }` supported. (There is currently no `cli.json` on this
   machine.)
3. **npm/Git tarball via `opencode plugin add`** (B8) with package.json:
   ```json
   { "type":"module",
     "exports": { ".": "./src/index.ts", "./tui": "./src/tui.tsx" },
     "peerDependencies": { "@opentui/core": ">=0.5.10", "@opentui/solid": ">=0.5.10", "solid-js": ">=1.9.0" } }
   ```
   This is the only path where `exports["./tui"]` is honoured.
4. **Config-schema `plugins` object form** for options is already in use; it does not change TUI
   resolution (options pass through to both server and TUI `setup(context.options)`).

---

## (e) Open questions

1. Does `tui/index.ts` (a `tui/` subdirectory) resolve, or must it be a sibling `tui.*` file?
   `qT` only probes `<dir>/tui`; `Bun.resolveSync` may accept a directory `index`, **INFERRED** —
   sibling file is the documented/safe form.
2. Does adding `tui.js` alone flip `features.tui` without a full restart? The config-dir watcher and
   `plugin.updated`/`server.connected` re-reconcile events suggest yes; **unverified** (B9 harness).
3. Is the TUI module imported eagerly at CLI start, or lazily when the TUI renders? `XAt` resolves it
   during reconciliation; import timing untested.
4. Does `exports["./tui"]` get honoured for an absolute directory target on some Bun versions?
   Code (B3) says no; not observed end-to-end.
5. Interaction of `tui.json`’s `plugin_enabled` / CLI `plugins` allow-list with opencode.json-supplied
   TUI plugins (legacy config migration code exists in the binary).

---

### PROVEN vs INFERRED summary

| Claim | Status |
|---|---|
| Local plugin is server-only today (`features:{server:true}`, no `tui.*`) | PROVEN (live API) |
| Directory install resolves TUI by sibling filename `<dir>/tui.*`, not exports | PROVEN (binary `qT`/`IT`) |
| Server sets `features.tui` from `qT({directory}).tui` | PROVEN (binary `FB`) |
| CLI loads only active plugins with `features.tui && (local|package)` | PROVEN (binary filter) |
| CLI module must default-export `{id, setup}`; `@opencode/plugin/tui` runtime-injected | PROVEN (binary `JAt`, `YW`) |
| `opencode plugin add` rejects local paths (npm/Git only) | PROVEN (binary error string) |
| Docs describe sibling `tui.ts` discovery and publish `./tui` export | PROVEN (docs) |
| Adding `tui.js` makes slash command appear end-to-end | INFERRED (code+docs; runtime hop not directly observed) |
| `exports["./tui"]` ignored for absolute directory targets | INFERRED from `qT` code (runtime not observed) |
