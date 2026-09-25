# Investigation — TUI Plugin Discovery & Native Settings Picker

**Date:** 2026-09-26 · **Status:** RESOLVED (native picker live)

## Question

Can a **directory-installed** server plugin ship a CLI/TUI component so its
slash command appears natively (like `/models`), without becoming an npm
package?

## Answer (evidence in `research/tui-plugin-discovery.md`)

**Yes — by filename convention.** The server loader resolves
`{server: "server"|"" , tui: "tui"}` in the plugin directory; the CLI filters
`features.tui === true` and loads `dirname(source.path)/tui`. `package.json`
`exports["./tui"]` only applies to npm/bare packages.

Required layout (ours):

```
~/.config/opencode/opencode-advisor/
├── index.js   ← server plugin (entrypoint from opencode.json)
└── tui.js     ← CLI plugin: Plugin.define from "@opencode/plugin/tui"
```

Result: `GET /api/plugin` → `features: {server: true, tui: true}`.

## Lessons (paid for in failures)

1. **`Keymap.Provider is missing`** — `context.keymap.layer()` is only valid
   inside a rendered slot. Register the layer from
   `context.ui.slot({append:"app", render: ...})` (documented session-panel
   pattern), not directly in `setup`.
2. **Stale entrypoint trap** — `cp dist/a.js dist/tui.js dir/` installs as
   `dir/opencode-advisor.js`, NOT `dir/index.js`. The loader kept running the
   old `index.js` and every new RPC method 404'd (`method_not_found`). Always
   copy server bundle → `index.js` explicitly; verify with a live RPC call
   before doubting the code.
3. **RPC envelope** — HTTP calls need `{"input": {...}}`; typed clients derive
   it from the definition, so the TUI and server must carry the **same
   schemas** (empty method stubs break serialization).
4. **Method names** — keep them single-word where possible; the dash attempt
   was inconclusive but unnecessary (`claim` works).
5. **Single slash entry** — the TUI claims the UI via `claim` RPC (persisted
   `tui:claimed` in plugin storage); the server then skips/`dispose()`s its
   executor-based settings command. Hosts without the CLI plugin keep the
   fallback. Claim is sent only after the keymap layer registers, so a failed
   TUI setup never suppresses the fallback.

## Verified live (2026-09-26)

- `features.tui: true`; CLI reconciliation shows 13 plugins (was 12).
- `claim` → `{"ok":true}`; kv `...:tui:claimed` persisted; server command
  list lost `advisor-settings` (only the native picker owns it now).
- Unconfigured consult (kimi executor, "advice" trigger):
  - user message in DB **clean** (0 directive leaks; transient system text)
  - tool returned `not_configured` + 3 setup steps
  - executor relayed steps verbatim, invented no advice
