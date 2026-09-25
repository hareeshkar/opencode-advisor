/**
 * V2 adapter — the verified, native path (OpenCode ≥ 2.0).
 *
 * Mapping of our architecture onto V2 primitives:
 *   advisor tool        → ctx.tool.transform (zero-arg JSON-Schema tool)
 *   task reset          → ctx.session.hook("prompt")
 *   timing/nudge inject → ctx.session.hook("context")  (transient — never persisted)
 *   advisor sub-call    → ctx.generate.text (no session, no tools, no history)
 *   usage ledger        → ctx.storage (durable, plugin-scoped)
 *
 * Silent-failure defenses (per repo issue research #44788/#40808/#50590):
 *   - loud, structured logging on every registration and failure path
 *   - startup self-probe verifies the advisor tool is actually registered
 *   - every hook body is fail-safe: an exception in a hook must never break
 *     the host's model call
 */

import { AdvisorEngine } from "./engine.js"
import { resolveOptions, shouldNudgeExecutor } from "./options.js"
import { ADVISOR_TOOL_DESCRIPTION, EXECUTOR_TIMING_PROMPT, NUDGE_TEXT, findTrigger, hasDirective, triggerDirective } from "./prompts.js"
import { frameAdvice } from "./sanitize.js"
import { PLUGIN_ID, PLUGIN_VERSION } from "./types.js"
import type { AdvisorOptions, Host, LogLevel, Slice, UsageEntry } from "./types.js"

/* ------------------------------------------------------------------ */
/* transcript normalization                                            */
/* ------------------------------------------------------------------ */

/** Best-effort text extraction from arbitrary payloads. Handles bare arrays
 *  (e.g. ToolStateCompleted.content[]) — an earlier version only detected
 *  arrays nested under a `.content` key and returned "" for direct arrays,
 *  which silently dropped every completed tool result on the V2 path. */
function toText(v: unknown, depth = 0): string {
  if (typeof v === "string") return v
  if (v === null || v === undefined || depth > 2) return ""
  if (Array.isArray(v)) return v.map((c) => toText(c, depth + 1)).filter(Boolean).join("\n")
  if (typeof v !== "object") return ""
  const rec = v as Record<string, unknown>
  for (const key of ["text", "output", "content", "result", "data"]) {
    if (key in rec) {
      const s = toText(rec[key], depth + 1)
      if (s) return s
    }
  }
  return ""
}

/**
 * Extract evidence from a V2 assistant tool part, matched against the real
 * ToolState union (completed | error | streaming | running):
 *  - completed → rendered text content (+ file-attachment note); args are
 *    included only when explicitly labeled as args, never as output
 *  - error → "[error] message" (+ any partial content)
 *  - streaming/running → undefined (partial JSON is not evidence)
 */
function toolSlice(name: unknown, part: unknown): Slice | undefined {
  const state = (part as { state?: unknown })?.state
  if (!state || typeof state !== "object") return undefined
  const st = state as { status?: unknown; input?: unknown; content?: unknown; error?: unknown }
  const label = typeof name === "string" ? name : "unknown"
  if (st.status === "streaming" || st.status === "running") return undefined
  if (st.status === "error") {
    const err = st.error as { message?: unknown } | undefined
    const msg = err && typeof err.message === "string" ? err.message : ""
    const partial = toText(st.content)
    const text = [msg ? `[error] ${msg}` : "", partial].filter(Boolean).join("\n")
    return text ? { role: "tool", name: label, text } : undefined
  }
  // completed (or unrecognized status carrying content): prefer rendered text
  const parts: string[] = []
  let files = 0
  if (Array.isArray(st.content)) {
    for (const c of st.content) {
      if (c !== null && typeof c === "object") {
        const block = c as Record<string, unknown>
        if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
          parts.push(block.text)
        } else if (block.type === "file") {
          files++
        }
      }
    }
  }
  if (files > 0) parts.push(`[${files} file attachment(s) omitted]`)
  if (parts.length === 0) {
    // No rendered content: fall back to args, explicitly labeled so the
    // advisor never mistakes the invocation for its result.
    const fromArgs = toText(st.input)
    if (fromArgs) parts.push(`[args] ${fromArgs}`)
  }
  if (parts.length > 0) return { role: "tool", name: label, text: parts.join("\n") }
  // last resort: bounded JSON of whatever the state holds
  try {
    const json = JSON.stringify(state)
    if (json && json !== "{}" && json !== "null") {
      return { role: "tool", name: label, text: json.slice(0, 400) }
    }
  } catch {
    /* circular — drop */
  }
  return undefined
}

/** Normalize V2 `session.context()` messages into host-agnostic slices. */
export function normalizeV2Transcript(messages: unknown): Slice[] {
  const out: Slice[] = []
  if (!Array.isArray(messages)) return out
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue
    const msg = m as Record<string, unknown>
    const type = msg.type
    if (type === "user" || type === "synthetic") {
      const rawText = typeof msg.text === "string" ? msg.text : ""
      const text = rawText || toText(msg.content) || toText(msg.parts)
      const files = Array.isArray(msg.files) ? msg.files.length : 0
      if (text || files > 0) {
        out.push({
          role: "user",
          name: type === "synthetic" ? "synthetic" : undefined,
          text: text || `[${files} image attachment(s); no extracted text]`,
        })
      }
      continue
    }
    if (type === "assistant") {
      const content = msg.content
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as Record<string, unknown>
          if (p?.type === "text" && typeof p.text === "string" && p.text.trim() !== "") {
            out.push({ role: "assistant", text: p.text })
          } else if (p?.type === "tool") {
            const s = toolSlice(p.name, p)
            if (s) out.push(s)
          }
          // reasoning parts are intentionally skipped: verbose, low advisor value
        }
      }
      continue
    }
    if (type === "shell") {
      const text = typeof msg.text === "string" ? msg.text : toText(msg.output)
      if (text) out.push({ role: "tool", name: "shell", text })
      continue
    }
    // system / compaction / idle / skill / *Selected → no advisor signal
  }
  return out
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false }

export function createV2Plugin(): { id: string; setup: (ctx: unknown) => Promise<() => void> } {
  return {
    id: PLUGIN_ID,
    async setup(ctxUnknown: unknown): Promise<() => void> {
      const ctx = ctxUnknown as any
      let opts: AdvisorOptions
      try {
        opts = resolveOptions(ctx?.options)
      } catch (err) {
        // loud + rethrow: a misconfigured plugin must not load silently
        console.error(`[${PLUGIN_ID}] CONFIG ERROR: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }

      if (!opts.advisor.providerID || !opts.advisor.id) {
        const msg =
          `[${PLUGIN_ID}] CONFIG ERROR: the V2 adapter routes through the host provider registry and ` +
          `requires "advisor" = { providerID, id } (source-only config is V1-only)`
        console.error(msg)
        throw new Error(msg)
      }

      const RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const
      const log = (level: LogLevel, message: string, data?: unknown): void => {
        if (RANK[level] < RANK[opts.logLevel]) return
        const line = `[${PLUGIN_ID}] ${message}`
        if (level === "error") console.error(line, data ?? "")
        else if (level === "warn") console.warn(line, data ?? "")
        else console.log(line, data ?? "")
      }

      // serialize usage writes so concurrent consults can't drop entries
      let usageChain: Promise<void> = Promise.resolve()
      const persistUsage = (entry: UsageEntry): Promise<void> => {
        usageChain = usageChain
          .then(async () => {
            const key = `usage:${entry.date}`
            const prev = (await ctx.storage.get(key)) as UsageEntry | undefined
            const merged: UsageEntry = prev
              ? {
                  date: entry.date,
                  calls: prev.calls + entry.calls,
                  errors: prev.errors + entry.errors,
                  estTokensIn: prev.estTokensIn + entry.estTokensIn,
                  estTokensOut: prev.estTokensOut + entry.estTokensOut,
                  adviceChars: prev.adviceChars + entry.adviceChars,
                }
              : entry
            await ctx.storage.set(key, merged)
          })
          .catch(() => {})
        return usageChain
      }

      const host: Host = {
        getTranscript: async (sessionID) => {
          const messages = await ctx.session.context({ sessionID })
          return normalizeV2Transcript(messages)
        },
        runAdvisor: async (prompt, signal, sessionID, nonce) => {
          // Session-scoped transient generation (NOT ctx.generate.text):
          // only session-bound requests emit hooks and inherit the host's
          // native session headers. The transient endpoint takes no model
          // parameter, so the advisor model is installed with a switchModel
          // SANDWICH around the call. Safety argument: the sandwich is
          // race-free because the session is blocked awaiting this very tool
          // result — no competing primary request can interleave. Parallel
          // advisor calls in one session all target the same advisor model.
          // The original model is restored in `finally`; if the restore
          // fails the session is left (visibly, repairably) on the advisor.
          const advisorRef: { providerID: string; id: string; variant?: string } = {
            providerID: opts.advisor.providerID,
            id: opts.advisor.id,
          }
          if (opts.advisor.variant) advisorRef.variant = opts.advisor.variant
          if (nonce && sessionID) {
            pendingAdvisorCalls.set(nonce, sessionID)
            const timer = setTimeout(() => pendingAdvisorCalls.delete(nonce), opts.timeoutMs + 30_000)
            if (typeof timer === "object" && timer !== null && "unref" in timer) {
              (timer as { unref(): void }).unref()
            }
          }
          let prev = sessionModel.get(sessionID)
          if (!prev) {
            try {
              const info = (await ctx.session.get({ sessionID })) as {
                model?: { providerID?: string; id?: string; variant?: string }
              }
              if (info?.model?.providerID && info?.model?.id) {
                prev = {
                  providerID: info.model.providerID,
                  id: info.model.id,
                  ...(info.model.variant ? { variant: info.model.variant } : {}),
                }
                sessionModel.set(sessionID, prev)
              }
            } catch {
              /* fall through to the guard below */
            }
          }
          if (!prev) {
            throw new Error(
              "refusing unsafe model sandwich: no tracked executor model for this session and session.get failed",
            )
          }
          const sameModel =
            prev.providerID === advisorRef.providerID &&
            prev.id === advisorRef.id &&
            (prev.variant ?? undefined) === (advisorRef.variant ?? undefined)
          if (!sameModel) {
            await ctx.session.switchModel({ sessionID, model: advisorRef })
          }
          let before = -1
          if (opts.logLevel === "debug") {
            try {
              before = ((await ctx.session.context({ sessionID })) as unknown[]).length
            } catch {
              before = -1
            }
          }
          try {
            const res = (await ctx.session.generate({ sessionID, prompt })) as { text?: unknown } | undefined
            const text = res?.text
            if (typeof text !== "string" || text.trim() === "") {
              const shape = res && typeof res === "object" ? Object.keys(res).join(",") : typeof res
              throw new Error(`advisor sub-call returned no text (response shape: ${shape})`)
            }
            if (opts.logLevel === "debug" && before >= 0) {
              try {
                const after = ((await ctx.session.context({ sessionID })) as unknown[]).length
                lastHistoryDelta = `${before}→${after}`
                if (after !== before) {
                  log("warn", `HISTORY CANARY: session.generate changed persisted history (${before} → ${after} messages)`)
                }
              } catch {
                lastHistoryDelta = "census-failed"
              }
            }
            return text
          } finally {
            if (nonce) pendingAdvisorCalls.delete(nonce)
            if (!sameModel) {
              try {
                await ctx.session.switchModel({ sessionID, model: prev })
              } catch (err) {
                log(
                  "error",
                  `FAILED to restore executor model ${prev.providerID}/${prev.id} — session left on advisor model; the next consult will repair it`,
                  err,
                )
              }
            }
          }
        },
        persistUsage,
        log,
      }
      const engine = new AdvisorEngine(opts, host)
      // Hook/tool registrations must be disposed on unload — otherwise a
      // plugin reload leaks callbacks and injections fire repeatedly.
      const regs: Array<{ dispose(): Promise<void> }> = []
      const sessionModel = new Map<string, { providerID: string; id: string; variant?: string }>()
      // In-flight advisor sub-calls awaiting native dispatch: evidence
      // nonce → originating sessionID. Lets the http.request hook attach
      // provider-required routing headers (x-opencode-session) that
      // transient generate.text calls otherwise lack. Empty 99.9% of the
      // time, so the hook's hot path is a single Map-size check.
      const pendingAdvisorCalls = new Map<string, string>()
      // Debug-only hook observability (surfaced in error results; the hot
      // path stays a size check + Set add in debug mode, nothing in release).
      let httpHookLive = false
      const observedKinds = new Set<string>()
      const modelRequestKinds = new Set<string>()
      const generateKinds = new Set<string>()
      let nonceMatches = 0
      let toolsStripped = 0
      let toolsSeen = 0
      let lastHistoryDelta = "n/a"
      // Executor model per session, tracked from primary context-hook
      // events. Lets runAdvisor restore the exact model after the advisor
      // sandwich below. Falls back to session.get when untracked.
      // Unproven hooks must never hang setup: bound every registration.
      const hookTimeout = (name: string): Promise<never> =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${name} hook registration timed out after 5000ms`)), 5000),
        )
      // Did our own transform see the tool land in the editor? Stronger than
      // a global name search for the startup self-probe.
      let editorSawAdvisor = false

      // --- 1) the zero-arg advisor tool ---------------------------------
      try {
        const reg1 = await ctx.tool.transform((editor: any) => {
          editor.add({
            name: "advisor",
            description: ADVISOR_TOOL_DESCRIPTION,
            input: EMPTY_INPUT,
            execute: async (_input: unknown, tctx: any) => {
              const sessionID = String(tctx?.sessionID ?? "")
              if (!sessionID) {
                return { content: "advisor_tool_result_error: unavailable — tool context carries no sessionID" }
              }
              const signal: AbortSignal = tctx?.signal ?? new AbortController().signal
              const r = await engine.consult(sessionID, signal)
              // Observable hook-delivery signal: last-write-wins health per
              // consult (bounded: 1 small write per consult, not per call).
              // Lets post-hoc analysis distinguish "hooks never delivered"
              // (timingInjected=false, steps high) from "model chose not to
              // call" — the key ambiguity of the pilot benchmark.
              try {
                void ctx.storage
                  .set("diag:health", { sessionID, time: Date.now(), ...engine.health(sessionID) })
                  .catch(() => {})
              } catch {
                /* storage unavailable — diagnostics only */
              }
              if (!r.ok) {
                log("warn", `consult failed: ${r.errorCode} — ${r.message}`)
                let content = `advisor_tool_result_error: ${r.errorCode} — ${r.message}`
                if (opts.logLevel === "debug") {
                  content += ` [diag: httpHookLive=${httpHookLive} kinds=[${[...observedKinds].join(",")}] mrKinds=[${[...modelRequestKinds].join(",")}] genKinds=[${[...generateKinds].join(",")}] nonceMatches=${nonceMatches} stripped=${toolsStripped} seen=${toolsSeen} hist=${lastHistoryDelta} pending=${pendingAdvisorCalls.size}]`
                }
                return { content }
              }
              return { content: frameAdvice(r.advice) }
            },
          })
          try {
            editorSawAdvisor = editor.list().some((t: any) => String(t?.id ?? "") === "advisor")
          } catch {
            /* editor introspection unavailable — fall back to ctx.tool.list() */
          }
        })
        regs.push(reg1)
      } catch (err) {
        log("error", "FAILED to register advisor tool — plugin non-functional", err)
        throw err
      }

      // --- 2) task reset + trigger-word routing on admitted prompts -----
      // The prompt hook receives an owned, mutable draft: edits become the
      // canonical persisted input. On a trigger word (advice/advisor/get
      // consultation, configurable) append a consult directive — the
      // executor then calls the advisor tool with full context and refines
      // its answer. Marker-guarded: never double-append (the /advisor
      // command composes the directive itself).
      try {
        const reg2 = await ctx.session.hook("prompt", (event: any) => {
          try {
            const sid = String(event?.sessionID ?? "")
            if (sid) engine.resetTask(sid)
            const text = typeof event?.prompt?.text === "string" ? event.prompt.text : ""
            if (text !== "" && !hasDirective(text)) {
              const matched = findTrigger(text, opts.triggers)
              if (matched) {
                event.prompt.text = `${text}\n\n${triggerDirective(matched)}`
                log("info", `advisor trigger "${matched}" — consult directive appended`)
              }
            }
          } catch (err) {
            log("warn", "prompt hook body failed (ignored — prompt proceeds)", err)
          }
        })
        regs.push(reg2)
      } catch (err) {
        log("warn", "prompt hook registration failed (per-task caps degrade to per-session; triggers inactive)", err)
      }

      // --- 2b) /advisor slash command ------------------------------------
      // Programmatic command registration (V2 API). Composes the directive
      // directly (with marker) so the prompt hook skips re-appending.
      try {
        const regCmd = await ctx.command.transform((editor: any) => {
          editor.add({
            name: "advisor",
            description: "Consult the high-judgment advisor model about the current task or a focus question.",
            execute: async ({ sessionID, prompt, delivery }: any) => {
              const focus = String(prompt?.text ?? "").trim()
              const body = focus !== "" ? `User request:\n${focus}` : "User request: (no focus given — review the current state of the task)"
              await ctx.session.prompt({
                sessionID,
                text: `${body}\n\n${triggerDirective("/advisor")}`,
                delivery,
              })
            },
          })
        })
        regs.push(regCmd)
      } catch (err) {
        log("warn", "/advisor command registration failed (trigger words still work)", err)
      }

      // --- 3) transient system injection (timing + nudge) -----------------
      try {
        const reg3 = await ctx.session.hook("context", (event: any) => {
          try {
            const sid = String(event?.sessionID ?? "")
            // Skip auxiliary / non-primary requests (compaction, title,
            // hidden generations share the hook identity) and malformed
            // events — they must never consume injection slots or steps.
            if (!sid) return
            if (event?.kind !== undefined && event.kind !== "primary") return
            const modelRef = event?.model
            const modelId = modelRef ? `${String(modelRef.providerID ?? "")}/${String(modelRef.id ?? "")}` : undefined
            // Track the executor model for the sandwich restore.
            if (modelRef && typeof modelRef.id === "string" && typeof modelRef.providerID === "string") {
              sessionModel.set(sid, {
                providerID: String(modelRef.providerID),
                id: String(modelRef.id),
                ...(typeof modelRef.variant === "string" ? { variant: modelRef.variant } : {}),
              })
            }
            // canInject: flags latch only when the system array is actually writable,
            // so a non-array event.system retries next call instead of losing the
            // injection for the whole task. Eligibility is lazy so tier regexes
            // run only when a nudge is actually on the table.
            const canInject = Array.isArray(event?.system)
            const d = engine.noteStep(sid, () => shouldNudgeExecutor(modelId, opts.nudge), canInject)
            // Permanent hook-delivery census: one tiny write on each session's
            // first model call (last-write-wins single key — bounded). Lets
            // post-hoc analysis prove hooks fire in any session type
            // (one-shot `run`, subagents, TUI) without per-call amplification.
            if (engine.health(sid).steps === 1) {
              try {
                void ctx.storage.set("diag:hookcheck", { sessionID: sid, time: Date.now() }).catch(() => {})
              } catch {
                /* diagnostics only */
              }
            }
            if (canInject) {
              if (d.injectTiming) event.system.push({ type: "text", text: EXECUTOR_TIMING_PROMPT })
              if (d.injectNudge) event.system.push({ type: "text", text: NUDGE_TEXT })
            }
          } catch (err) {
            log("warn", "context hook body failed (ignored — model call proceeds)", err)
          }
        })
        regs.push(reg3)
      } catch (err) {
        log("warn", "context hook registration failed (timing prompt will not be injected)", err)
      }

      // --- 4) native request observation + session-header injection ----
      // Fires for every native provider request a session issues. Correlates
      // advisor sub-calls by their evidence nonce (embedded in the prompt
      // body) and attaches x-opencode-session so session-routed providers
      // (opencode-go) accept the call and can apply prompt caching.
      // The registration itself is race-guarded: an unproven hook must never
      // hang setup and take the advisor tool down with it.
      try {
        const regHttp = await Promise.race([
          ctx.session.hook("http.request", async (event: any) => {
            try {
              if (opts.logLevel === "debug") {
                httpHookLive = true
                observedKinds.add(String(event?.kind ?? "?"))
              }
              if (pendingAdvisorCalls.size === 0) return
              const req = event?.request as { clone(): { text(): Promise<string> }; headers: { set(k: string, v: string): void } } | undefined
              if (!req || typeof req.clone !== "function") return
              const body = await req.clone().text().catch(() => "")
              if (!body) return
              for (const [nonce, sid] of pendingAdvisorCalls) {
                if (body.includes(nonce)) {
                  req.headers.set("x-opencode-session", sid)
                  nonceMatches++
                  log("debug", `attached x-opencode-session for advisor sub-call (kind=${String(event?.kind ?? "?")})`)
                  break
                }
              }
            } catch (err) {
              log("warn", "http.request advisor hook failed (ignored — request proceeds)", err)
            }
          }),
          hookTimeout("http.request"),
        ])
        regs.push(regHttp)
      } catch (err) {
        log("warn", "http.request hook unavailable (session-routed providers may refuse advisor calls)", err)
      }

      // --- 4c) generate-kind tool stripping (recursion defense) ---------
      // session.generate assembles the session's tool catalog unless told
      // otherwise — including our own `advisor` tool. Correlate EXACTLY via
      // the evidence nonce in the transient messages (the generate hook
      // carries full messages, unlike http.request which needs body reads),
      // and strip tools only for our own sub-calls. All other generate-kind
      // requests pass through untouched.
      try {
        const regGen = await Promise.race([
          ctx.session.hook("generate", (event: any) => {
            try {
              if (opts.logLevel === "debug") {
                generateKinds.add("generate")
              }
              if (pendingAdvisorCalls.size === 0) return
              const messages = Array.isArray(event?.messages) ? event.messages : []
              let haystack = ""
              for (const m of messages) {
                const c = (m as { content?: unknown })?.content
                if (typeof c === "string") haystack += c + "\n"
                else if (Array.isArray(c)) {
                  for (const p of c) {
                    const part = p as { text?: unknown }
                    if (part && typeof part.text === "string") haystack += part.text + "\n"
                  }
                }
              }
              for (const nonce of pendingAdvisorCalls.keys()) {
                if (haystack.includes(nonce)) {
                  try {
                    toolsSeen += Object.keys((event as { tools?: object }).tools ?? {}).length
                  } catch {
                    /* introspection failed — proceed to strip */
                  }
                  event.tools = {}
                  toolsStripped++
                  log("debug", "stripped tools from advisor sub-call (recursion defense)")
                  break
                }
              }
            } catch (err) {
              log("warn", "generate hook failed (ignored — request proceeds)", err)
            }
          }),
          hookTimeout("generate"),
        ])
        regs.push(regGen)
      } catch (err) {
        log("warn", "generate hook unavailable (advisor sub-calls may see session tools)", err)
      }
      // Records which request kinds reach the model layer, including for
      // transient calls. Race-guarded like all unproven hooks.
      // --- 4b) model-request observation (diagnostic depth) ---------------
      // Records which request kinds reach the model layer, including for
      // transient calls. Race-guarded like all unproven hooks.
      try {
        const regModel = await Promise.race([
          ctx.session.hook("model.request", (event: any) => {
            try {
              if (opts.logLevel === "debug") {
                modelRequestKinds.add(String(event?.kind ?? "?"))
              }
            } catch {
              /* never break the request */
            }
          }),
          hookTimeout("model.request"),
        ])
        regs.push(regModel)
      } catch (err) {
        log("warn", "model.request hook unavailable (diagnostic depth reduced)", err)
      }

      // --- 5) self-probe: prove the tool is actually registered ----------
      try {
        const tools = await ctx.tool.list()
        const listed = Array.isArray(tools) && tools.some((t: any) => String(t?.id ?? t?.name ?? "") === "advisor")
        if (editorSawAdvisor && listed) {
          log("info", `ready v${PLUGIN_VERSION} — tool=✓ advisor=${opts.advisor.providerID}/${opts.advisor.id} maxUses/task=${opts.maxUsesPerTask} budget=${opts.adviceWordBudget}w`)
        } else {
          log("error", `SELF-PROBE WEAK: editorSaw=${editorSawAdvisor} listed=${listed} — the tool may register without dispatching (host issue class #44788). Consults will warn if hooks never deliver.`)
        }
      } catch (err) {
        log("warn", "self-probe could not list tools", err)
      }

      return async () => {
        // Drain queued usage writes so a hot unload can't drop ledger entries,
        // then release every registration we own.
        await usageChain.catch(() => {})
        await Promise.allSettled(regs.map((r) => Promise.resolve().then(() => r.dispose())))
        log("info", `unloaded v${PLUGIN_VERSION}`)
      }
    },
  }
}
