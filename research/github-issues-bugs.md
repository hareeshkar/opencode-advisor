# GitHub Issue Mining — Bug & Painpoint Intelligence for opencode-advisor

**Date:** 2026-09-25 · **Sources:** `opencode-ai/opencode`, `anomalyco/opencode`, awesome-opencode README, 3 known external issues. ~48 gh API calls (search rate-limit hit twice; recovered).

## ⚠️ Repo topology finding (read first)

- **`opencode-ai/opencode` is ARCHIVED** (last push 2025-09-18, 158 open issues, `gh api repos/opencode-ai/opencode` → `archived: true`). Searches for `plugin hook`, `plugin not loading`, `tool.transform`, `session hook`, `plugin migration`, `migrate v2`, `v2 migration`, `plugin v2`, `advisor`, `second model`, `model routing`, `delegate` all returned **zero results**. Only 3 loose `plugin` matches: #61 *Use opencode headless* (open, 9c), #285 *Jetbrains MCP freeze on Startup* (open, 1c), #270 *Error: Failed to process events: request config: base url is not set* (open, 12c) — none are plugin-API bugs.
- **`anomalyco/opencode` is the live repo** (6,254 open issues, pushed 2026-09-25) and hosts **both** the V1 (1.18.x, `@opencode-ai/plugin`) and V2 (2.0.x, `@opencode/plugin`) issue stream. All real plugin-API intelligence below therefore comes from `anomalyco/opencode`; issues are tagged **[V2]** or **[V1]** by the API generation they concern.

---

## 1. V2 PLUGIN API ISSUES

Searches on `opencode-ai/opencode`: all relevant terms returned `[]` (archived repo — recorded as explicit signal above). V2-era issues from `anomalyco/opencode`:

| # | Title | State | C | Takeaway |
|---|-------|-------|---|----------|
| [44788](https://github.com/anomalyco/opencode/issues/44788) | plugins: `event.subscribe` delivers no events; context-hook and synthetic injections never reach the model prompt (beta 18050) | open | 5 | **[V2] Worst case for us:** all three `ctx.event.subscribe` call forms register but deliver zero events, `session.hook("context")` mutations never reach the model, `session.synthetic` messages appear in `/context` but not in the actual prompt — docs-following plugin authors get *silent no-ops*. |
| [50590](https://github.com/anomalyco/opencode/issues/50590) | plugin: function default export rejected by v2 loader schema (SDK root Plugin type mismatch) | open | 1 | **[V2]** `@opencode-ai/plugin` root *types* allow a function default export; the V2 runtime loader requires an object `{id, setup\|effect}`. Compiles clean, fails only at load with a WARN (no ERROR line) — type contract ≠ runtime contract. |
| [50434](https://github.com/anomalyco/opencode/issues/50434) | plugins: local plugins cannot resolve `@opencode/plugin` import (2.0.12) | open | 1 | **[V2]** Documented pattern `import { Plugin } from "@opencode/plugin"` fails with `Cannot find package '@opencode/plugin'` even though Node/Bun resolve it fine — the server's plugin module resolver is at fault; needs a no-import workaround. |
| [49608](https://github.com/anomalyco/opencode/issues/49608) | plugins for V2: local plugin paths fail to load (file entries rejected, `@opencode/plugin` unresolvable) | open | 1 | **[V2]** Same family: local file-path plugin entries rejected outright in V2 config. |
| [48138](https://github.com/anomalyco/opencode/issues/48138) | [FEATURE]: backward compatibility for v1 plugins in v2 | open | 2 | **[V2]** Loader schema requires `export default {id, setup\|effect}`; every V1 plugin (rtk, herdr, …) exporting a factory function breaks at once on upgrade, only fix is a full rewrite. Requests `experimental.legacy_plugins` flag. |
| [40808](https://github.com/anomalyco/opencode/issues/40808) | Document (or shim) the v1 → v2 plugin event renames: legacy `tool.execute.*` / `file.changed` subscriptions now fail silently | open | 0 | **[V2]** V2 renamed events (`tool.execute.before` → `session.next.tool.called` etc., 167 event types); legacy subscriptions register, log "returning hooks", then never fire — zero error, zero log. Verified with marker-file probes. |
| [50133](https://github.com/anomalyco/opencode/issues/50133) | Plugin hook parity with Claude Code lifecycle events (7 gaps) | open | 0 | **[V2]** Careful hook-mapping audit: most of Claude Code's 33 hooks port (PreToolUse→`tool.execute.before`, Stop→`session.idle`, …) but 7 gaps exist, incl. **no PostToolUseFailure signal** (`tool.execute.after` gets `{title, output, metadata}` with no failure flag). |
| [50729](https://github.com/anomalyco/opencode/issues/50729) | [FEATURE]: New `chat.model` hook | open | 1 | **[V2]** Explicit request for a per-step model-selection hook (points to older issues 18793, 24006) — i.e. **there is still no supported way to choose the model per step from a plugin**. |
| [49712](https://github.com/anomalyco/opencode/issues/49712) | Plugins: `chat.params` hook cannot override the model (only sampling params) — model-switch plugins forced to abort+resend | open | 0 | **[V1/V2]** `chat.params` overrides `temperature/topP/reasoningEffort/maxTokens/thinking` only — **not `providerID`/`modelID`**. Any fallback/routing plugin must abort the session and re-send with `body.model`, breaking one-shot `opencode run`. |
| [45764](https://github.com/anomalyco/opencode/issues/45764) | [FEATURE]: Plugin hook to intercept/override LLM call parameters (`llm.request.before`) | open | 2 | Requested hook with `output.params.model` override for automatic model routing — **still unimplemented**; unknown hooks produce `output === undefined` rather than an error. |
| [47200](https://github.com/anomalyco/opencode/issues/47200) | Plugin load failures are published to the event bus but never logged | open | 0 | Load failures go to an event bus nobody watches; the log stays clean → invisible breakage. |
| [50404](https://github.com/anomalyco/opencode/issues/50404) | plugins: `AgentEditor` has no `add()`, so a plugin cannot register a new agent | open | 1 | SDK surface gap: cannot programmatically add agents (relevant if advisor wants to register an `advisor` agent). |
| [33896](https://github.com/anomalyco/opencode/issues/33896) | Skill registered via v2 plugin is not discoverable via `/skills` | closed | 5 | `ctx.skill.transform()` with `type:"embedded"` registers silently but never shows in `/skills` — registration ≠ discovery in V2. |
| [35963](https://github.com/anomalyco/opencode/issues/35963) | fix(core): isolate invalid plugin tools during reload | open | 2 | One invalid plugin tool can poison reload; fix pending. |
| [50652](https://github.com/anomalyco/opencode/issues/50652) | External plugin tools bypass configured permissions | open | 1 | Plugin-registered tools skip the permission system — security-relevant if we ship a tool. |
| [47495](https://github.com/anomalyco/opencode/issues/47495) | plugin: `permission.evaluate` ask verdicts ignored on beta-19151 (deny still honored) | open | 2 | Partial hook enforcement: `deny` works, `ask` verdict silently ignored. |
| [48514](https://github.com/anomalyco/opencode/issues/48514) | Plugin and provider loaders cache the same package under two keys, never refresh an existing install | open | 3 | Stale-plugin-cache bug; upgrades don't take effect. |
| [50080](https://github.com/anomalyco/opencode/issues/50080) | plugin install: TUI plugin fails with empty `NpmInstallFailedError` — resolver rejects a spec npm installs fine | open | 0 | Install-time resolver disagrees with npm. |
| [51209](https://github.com/anomalyco/opencode/issues/51209) | [FEATURE]: Expose the V2 TUI composer to plugins | open | 0 | TUI surface still closed to V2 plugins. |

## 2. V1 PLUGIN ISSUES (`anomalyco/opencode`, `@opencode-ai/plugin` 1.18.x era)

| # | Title | State | C | Takeaway |
|---|-------|-------|---|----------|
| [7006](https://github.com/anomalyco/opencode/issues/7006) | `permission.ask` plugin hook is defined but not triggered | open | 19 | **Highest-signal plugin bug:** hook is in `@opencode-ai/plugin` types but `PermissionNext.ask()` publishes straight to the UI bus — `trigger()` never called. Plugin "detected, loaded, initialized, but not executing" (newbie filed it: totally opaque). |
| [47674](https://github.com/anomalyco/opencode/issues/47674) | `permission.ask` plugin hook is never triggered | open | 1 | Re-verification: `trigger(` appears in 6 places repo-wide (`shell.env`, `experimental.chat.*`, `tool.definition`) — `permission.ask` not among them. Silent ignore, no warning. |
| [39031](https://github.com/anomalyco/opencode/issues/39031) | Hung plugin hook silently discards prompts after `prompt_async` returns 204 | open | 1 | **`Effect.promise` hooks have no timeout and are non-interruptible** → one never-resolving `chat.message` hook parks the prompt fiber forever; API already acked 204, prompt silently lost (reporter lost 40/120 concurrent dispatches). |
| [42451](https://github.com/anomalyco/opencode/issues/42451) | Legacy plugin loader pushes non-Hooks return values, corrupting plugin loading and crashing startup | open | 6 | Legacy loader calls **every** exported function as a plugin factory and pushes `undefined` returns into the shared hooks array → later `hook.provider` access crashes `Provider.list` at boot. Fix: filter non-Hooks entries. |
| [33455](https://github.com/anomalyco/opencode/issues/33455) | Plugins from config `plugin` array silently not loaded since v1.17.0 | closed | 2 | Whole plugin-loading step silently absent from startup (no error/warning/log) on compiled binaries — regression shipped and sat undetected. |
| [38604](https://github.com/anomalyco/opencode/issues/38604) | Desktop app: local plugins load and register but their hooks (`tool.execute.before`, `event`) never invoked | closed | 1 | **Desktop embedded server ≠ CLI**: same plugin file green in status popover yet hooks never fire; works under `opencode run`. Dispatch gap is host-dependent. |
| [27557](https://github.com/anomalyco/opencode/issues/27557) | Desktop sidecar exits silently with code 1 — third-party plugin's global `uncaughtException` handler calls `process.exit(1)` | closed | 3 | A plugin installing a global `process.on('uncaughtException')` that exits kills the whole Desktop sidecar 30s–10min after start ("server is dead"). **We must never register global handlers that exit.** |
| [46115](https://github.com/anomalyco/opencode/issues/46115) | Session title generation bypasses plugin hooks | open | 0 | Auto title-generation path skips the plugin pipeline entirely. |
| [39674](https://github.com/anomalyco/opencode/issues/39674) | `tool.execute.before` hook: mutations to `output.args` do not propagate to tool execution | closed | 2 | Arg-rewriting via the before-hook silently no-ops — mutation semantics unreliable. |
| [38956](https://github.com/anomalyco/opencode/issues/38956) | Custom tool with `tool.schema.number()` argument crashes: `Cannot read properties of undefined (reading 'split')` | closed | 1 | Schema-builder edge case crashes the tool pipeline. |
| [30268](https://github.com/anomalyco/opencode/issues/30268) | Question: register a custom slash command as a pure side-effect (no AI prompt) from a local plugin | closed | 2 | API-shape confusion signal: side-effect-only commands aren't a documented pattern. |
| [46095](https://github.com/anomalyco/opencode/issues/46095) | plugins: transient first import failure permanently poisons plugin resolution until restart (Windows) | open | 2 | A single race on first import caches the failure for the process lifetime — even after fixing the file, plugin stays `failed` until restart. |
| [46560](https://github.com/anomalyco/opencode/issues/46560) | `/status` shows mangled plugin names for path-registered plugins on Windows | open | 2 | Windows `fileURLToPath` backslash bug in display (cosmetic, but shows path-plugin handling is under-tested). |
| [42051](https://github.com/anomalyco/opencode/issues/42051) | tui: plugins no longer load after `cli.json` config migration (nightly) | open | 1 | Config migration drops plugins. |
| [37533](https://github.com/anomalyco/opencode/issues/37533) / [36505](https://github.com/anomalyco/opencode/issues/36505) | plugin list crashes & config plugins not loaded / external TUI plugins parsed but not loaded | closed | 2 / 2 | Load-vs-list split bugs: parsed but never loaded. |
| [18969](https://github.com/anomalyco/opencode/issues/18969) | [FEATURE]: add `tui.footer.items` plugin hook for persistent status display | open | 12 | Most-requested missing hook (12c) — plugins want live status display (useful for an "advisor consulted" indicator). |

## 3. MIGRATION PAIN POINTS (V1 → V2)

Searches `migrate v2` → **zero results in both repos**; `v2 migration` / `plugin v2` / `v1 to v2` / `plugin migration` on `anomalyco/opencode` returned the issues below.

**Recurring themes:**
1. **No plugin migration path at all** — [#48365](https://github.com/anomalyco/opencode/issues/48365) (open, 2c): *all* V1 plugins unloadable under V2 schema, no migration guide, no V2 plugin docs for agents ("cost a full hardening pass to diagnose instead of ten minutes with docs"). Reinforced by [#48138](https://github.com/anomalyco/opencode/issues/48138) (open, 2c) and [#50172](https://github.com/anomalyco/opencode/issues/50172) (open, 3c) / [#50140](https://github.com/anomalyco/opencode/issues/50140) (open, 0c): V1 file-plugin loader never falls back to legacy named exports when a V2 default export is present.
2. **Event/hook renames fail silently** — [#40808](https://github.com/anomalyco/opencode/issues/40808) (open, 0c): legacy `tool.execute.*`/`file.changed` subscriptions dead with no error (see §1).
3. **History/data migration is lossy** — [#42671](https://github.com/anomalyco/opencode/issues/42671) (open, 2c): corrupt-part migrator 500s, undecodable rows give no field detail, >9k-message imports 500 with empty body, project picker is a hidden shortcut. Plus [#50800](https://github.com/anomalyco/opencode/issues/50800) (1c) V1 sessions in non-git dirs invisible; [#51176](https://github.com/anomalyco/opencode/issues/51176) (0c) V1 "global" sessions unattributed; [#50130](https://github.com/anomalyco/opencode/issues/50130) (0c) V1 sessions created *after* migration never imported; [#50260](https://github.com/anomalyco/opencode/issues/50260) (1c) delete leaves pre-V2 rows orphaned.
4. **Config/env regressions on upgrade** — [#51107](https://github.com/anomalyco/opencode/issues/51107) (1c) V2 ignores `%ProgramData%\opencode` managed config; [#48853](https://github.com/anomalyco/opencode/issues/48853) (closed, 1c) `OPENCODE_CONFIG` ignored; [#36990](https://github.com/anomalyco/opencode/issues/36990) (1c) env-var compat; [#44019](https://github.com/anomalyco/opencode/issues/44019) (0c) migrator nests provider state wrongly; [#44028](https://github.com/anomalyco/opencode/issues/44028) (1c) mixed stable/beta channels sharing a data dir silently split sessions across `session`/`session_v2`.
5. **Feature parity gaps blamed on migration** — [#49986](https://github.com/anomalyco/opencode/issues/49986) (0c) no native V2 replacement for provider model filtering; [#50299](https://github.com/anomalyco/opencode/issues/50299) (1c) V2 Console lost 14 locales; [#49879](https://github.com/anomalyco/opencode/issues/49879) (4c) V2 Plan mode lost V1's plan-file workflow.

## 4. ADVISOR / MULTI-MODEL RELATED

`opencode-ai/opencode`: `advisor`, `second model`, `model routing`, `delegate` → **all zero results** (archived). `anomalyco/opencode` results:

| # | Title | State | C | Takeaway |
|---|-------|-------|---|----------|
| [21789](https://github.com/anomalyco/opencode/issues/21789) | Feature Request: Support Anthropic Advisor Strategy (`advisor_20260301`) | **closed** | 5 | Direct prior art: requests exactly our feature — server-side `advisor_20260301` tool, beta header `anthropic-beta: advisor-tool-2026-03-01`, executor consults Opus in one `/v1/messages` call. Closed (not shipped in core) ⇒ demand exists, plugin is the right vehicle. |
| [23058](https://github.com/anomalyco/opencode/issues/23058) | [FEATURE]: Anthropic "advisor strategy" | **closed** | 5 | Duplicate request citing the Claude Code blog post (Opus advisor + Sonnet/Haiku executor, near-Opus quality at Sonnet cost). Also closed. |
| [34370](https://github.com/anomalyco/opencode/issues/34370) | [FEATURE] Multi-model orchestration: intent-based routing, vision delegation, **turn-level advisor** | open | 4 | Asks for `prompt.classify`-style hook, vision delegation, and a turn-level advisor agent — all three unbuilt; cites oh-my-pi's `default/smol/slow/plan/commit` roles. |
| [7602](https://github.com/anomalyco/opencode/issues/7602) | [FEATURE]: Native Model Fallback / Failover Support | open | **30** | Most-discussed multi-model issue: no cross-model fallback in core, users pushed to external routers (litellm). Pain is real and unsolved. |
| [40948](https://github.com/anomalyco/opencode/issues/40948) | [FEATURE] Mixture of Agents (MoA) as a first-class model/preset | open | 0 | MoA ensemble request — adjacent to advisor pattern. |
| [39253](https://github.com/anomalyco/opencode/issues/39253) | Feature Request: DAP Debugger Integration & Advisor Model | open | 2 | Users bundle "advisor model" requests with other features. |
| [46794](https://github.com/anomalyco/opencode/issues/46794) | Auto-switch to vision model when images enter the agent loop | open | 0 | Capability-based routing request — same missing-hook family. |
| [46122](https://github.com/anomalyco/opencode/issues/46122) | [FEATURE]: Possibility for choosing the model for the subagents | open | 2 | Per-subagent model choice still requested ⇒ likely partially missing in V2. |
| [50925](https://github.com/anomalyco/opencode/issues/50925) | agents: `mode:all` configured model ignored at subagent spawn — parent model inherited | open | 0 | **Routing config silently ignored** — subagent spawns on parent model. |
| [42561](https://github.com/anomalyco/opencode/issues/42561) | `run --agent` ignores the agent's declared model and silently resolves global default | open | 1 | Same bug class on the headless path. |
| [50795](https://github.com/anomalyco/opencode/issues/50795) / [41136](https://github.com/anomalyco/opencode/issues/41136) | Subagents tab hides effective child model and variant / show resolved model for delegated Task subagents | open | 1 / 1 | Users can't tell which model a delegation actually ran on — observability gap for us to fill. |
| [46491](https://github.com/anomalyco/opencode/issues/46491) | Independent Task subagents run sequentially with GPT-5.6-sol (OpenAI) | open | 2 | Provider-dependent parallelism failure. |
| [44859](https://github.com/anomalyco/opencode/issues/44859) | Concurrent task delegation can fail persistence then return an empty success payload | open | 1 | **Delegation returns fake success** — must validate results ourselves. |
| [48683](https://github.com/anomalyco/opencode/issues/48683) | One-shot `run` exits before plugin-backgrounded work completes; plugins cannot detect a headless client on the shared service | open | 1 | Background advisor calls in one-shot mode may be killed at exit. |
| [48409](https://github.com/anomalyco/opencode/issues/48409) | [FEATURE]: Allow custom plugin tools to use the native subagent progress UI | open | 1 | Plugin tools can't show progress like native subagents. |
| [45078](https://github.com/anomalyco/opencode/issues/45078) | Task subagents inherit parent session denies that later rules supersede | open | 2 | Permission inheritance staleness across delegation. |
| [50806](https://github.com/anomalyco/opencode/issues/50806) | subagent: custom agent spawn fails with "free tier can only be used from within OpenCode" | open | 1 | Provider-tier check blocks programmatic spawns. |
| [48164](https://github.com/anomalyco/opencode/issues/48164) | [FEATURE]: List AllaiGate Model Router in the plugin ecosystem | open | 0 | Third-party model routers compete/cluster in this space. |

**External issues (given, verbatim — not re-researched):**
- **anthropics/claude-code#46105** — Claude Code 1.100 sends `advisor-tool-2026-03-01` beta headers to custom `ANTHROPIC_BASE_URL` → HTTP 400. *Proves client-side emulation is needed; naive passthrough of the beta header breaks custom gateways.*
- **vercel/ai#18389** — `@ai-sdk/anthropic` forwarding `maxTokens` on `advisor_20260301` (min 1024, recommend 2048). *Advisor tool calls carry a maxTokens floor we must enforce.*
- **BerriAI/litellm#25516** — Claude Code `/advisor` rollout; Vertex + `advisor-tool` header verification. *Proxies/gateways must verify/handle the advisor header — expect non-Anthropic relays to choke on it.*

## 5. ECOSYSTEM SIGNAL (awesome-opencode/awesome-opencode README, raw)

Plugins relevant to orchestration / multi-model / advisory:

| Plugin | 1-line |
|---|---|
| **deliberation** ([antonbabenko/deliberation](https://github.com/antonbabenko/deliberation)) | **Closest existing thing to us:** delegated second opinion or fix from GPT/Gemini/Grok/OpenRouter as 7 expert subagents over MCP; `ask-all` consensus + `consensus` arbiter loop. |
| **@bluelovers/opencode-arise** | Solo Leveling-themed orchestrator harness; parallel background task execution, **custom model per agent** via config. |
| **FlowDeck** | Multi-agent workflow orchestration with safety intelligence — 25 specialist agents, discuss/plan/execute/review cycle, state survives restarts; `/fd-council` ensemble consensus. |
| **Oh My Opencode Slim** | Lightweight fork of oh-my-opencode; specialized sub-agents (Explorer, Oracle, Librarian…), token-optimized orchestration. |
| **Open Dynamic Workflows** | Claude-Code-style dynamic workflows; local daemon runs orchestration script with concurrent agents + adversarial verification, crash-resume; BYO model (Anthropic/OpenAI-compat/Ollama). |
| **Open Conclave** | Multi-agent debates moderated by a captain agent until consensus; per-agent provider/model override in config. |
| **OpenCode Ensemble** | Parallel agent teams with peer messaging, shared task board, worktree isolation, live dashboard. |
| **OpenCode Swarm** | Verification-gated swarm: architect/review/test/security agents with resumable evidence. |
| **Pocket Universe** | Closed-loop, resilient async subagents (vs. fire-and-forget) with inter-agent communication tools. |
| **OpenCode Mission Control** | Command center for parallel agents: tmux worktrees, DAG plans, autopilot/copilot/supervisor modes, merge train. |
| **Opencode Workspace** | Bundled multi-agent orchestration harness, 16 components in one install. |
| **Background Agents** | Claude Code-style background agents with async delegation and context persistence. |
| **CrewBee** | Task-specific agent teams; switches single↔multi-agent by task complexity, team templates with review flow. |
| **CLI Proxy API** (router-for-me) | Multi-model proxy exposing compatible API interfaces for multiple model CLIs. |
| **Opencode LiteLLM** | Zero-config LiteLLM provider — auto-discovers every model behind a LiteLLM proxy (routing infrastructure). |
| **opencode-agent for Cowork** | Agent routing (build/plan/@general), stall detection, result validation, **provider fallback chain anthropic→openrouter→openai**. |
| **Micode** | Brainstorm-plan-implement workflow with subagent orchestration and git worktree isolation. |
| **Gem Team** | Self-learning multi-agent orchestration harness for spec-driven development. |
| **Subtask2** | Extends `/commands` into an orchestration system with granular flow control. |
| **opencode-bmad-workflow** | BMAD multi-agent pipeline (epic/feature/sprint/code review). |
| **hiai-opencode** | Canonical 12-agent model with bundled skills, MCP, LSP, ralph-loop. |
| **Model Announcer** | Model self-awareness — injects which model is running (tiny, but a pattern we may need). |
| **opencode-telemetry** | Cost rollups across orchestration chains (conductor + child sessions) — relevant for advisor cost accounting. |

**Gap signal:** grep for `advisor`/`advisory` in the README matches **no plugin** — there is no named advisor plugin in the ecosystem; the closest are `deliberation` (MCP, explicit commands, not mid-task) and `oh-my-opencode`'s Oracle-style subagents (separate session, not in-loop).

## 6. IMPLICATIONS FOR US (opencode-advisor)

1. **Assume silent failure, not errors.** V2 hooks can register and deliver nothing — #44788, #40808, #47200, #50590 (WARN-only load failure). Our plugin must self-probe at startup (fire a test event / assert handler ran on turn 1) and surface a visible status, never trust "loaded".
2. **Don't depend on `event.subscribe` for the core path.** All three subscribe forms were dead in #44788; context-hook mutations never reached the prompt. Build the advisor trigger on the most-executed verified hook (`chat.message` / `tool.execute.before` / `session.idle` per #50133's mapping) and degrade gracefully.
3. **Never do mid-flight model switching via `chat.params`** — it cannot override `providerID`/`modelID` (#49712); the only path is abort+resend, which breaks one-shot `opencode run` (#49712) and there is no `chat.model`/`llm.request.before` hook yet (#50729, #45764). ⇒ call the advisor model directly with our own client/SDK instead of asking OpenCode to route.
4. **Timeout every hook, and keep it interruptible.** `Effect.promise` hooks are non-interruptible with no timeout; a hung `chat.message` hook silently discards acked prompts (#39031, 40/120 dispatches lost). Our hooks must resolve fast, offload long advisor calls to background, and always settle.
5. **No global process handlers.** A plugin's `uncaughtException` → `process.exit(1)` killed the Desktop sidecar (#27557). We must not install global handlers, and should be defensive if another plugin does.
6. **Export shape matters more than types say.** V2 runtime requires `export default {id, setup}` object while root types allow a function (#50590); legacy loader calls *every* named export as a factory and crashes boot on `undefined` returns (#42451). Ship exactly one default object export, no stray helper exports; handle `@opencode/plugin` resolution failure with a bundled/no-import fallback (#50434, #49608).
7. **CLI vs Desktop vs headless are three different hosts.** Hooks fire under CLI but not Desktop's embedded server (#38604), config-array plugins silently skipped on some builds (#33455), `run --agent` ignores declared models (#42561), one-shot `run` exits before plugin background work completes (#48683). Test all three; flush/await advisor results before exit.
8. **Windows and cold-start races.** First-import failure caches as permanent failure until restart (#46095); path plugins mis-display (#46560); `.ts` local plugins fail on Windows (#42763). Document install via npm-safe entry and handle resolve errors as retryable.
9. **Validate delegated work yourself.** Concurrent task delegation can fail persistence yet return empty success (#44859); subagents inherit stale permission denies (#45078); spawn can be blocked by tier checks (#50806). If our advisor path delegates, verify the response payload, don't trust success codes.
10. **Surface which model actually answered.** Effective child model is hidden (#50795, #41136) and configured subagent models are silently ignored (#50925, #42561) — we should print "advisor: <model>, N tokens, Xms" ourselves as a TUI footer/status item (cf. the 12-comment request for `tui.footer.items` #18969, and #48409 asking for plugin tools to reuse the subagent progress UI).
11. **Enforce advisor-call constraints the platform won't.** `maxTokens` floor (min 1024, recommend 2048) and beta-header behavior are our responsibility: sending `advisor-tool-2026-03-01` headers to custom base URLs causes HTTP 400 (claude-code#46105), and proxies/Vertex need header verification (litellm#25516). ⇒ default to client-side emulation, strip/never-forward the beta header, clamp `max_tokens` (#18389).
12. **Positioning: this is an unmet, twice-closed feature request.** Core rejected/never shipped native advisor support (#21789 closed, #23058 closed) while #7602 (30 comments) shows cross-model fallback demand and #34370 asks for turn-level advisor explicitly — and no advisor plugin exists in awesome-opencode. Ship it as a plugin with clear V2-loader compliance, a status indicator, and cost telemetry (pattern: opencode-telemetry).

---
*Method: `gh search issues` (terms listed per section), body fetches for the top-commented issues via `gh api repos/.../issues/<n>` and one GraphQL batch, awesome-opencode README via raw curl. Searches returning `[]` are recorded as explicit zero-result signals.*
