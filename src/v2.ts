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
import { ADVISOR_TOOL_DESCRIPTION, EXECUTOR_TIMING_PROMPT, NUDGE_TEXT } from "./prompts.js"
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
        runAdvisor: async (prompt, signal) => {
          const model: Record<string, string> = { providerID: opts.advisor.providerID, id: opts.advisor.id }
          if (opts.advisor.variant) model.variant = opts.advisor.variant
          // requestOptions.signal (typed on RequestOptions) lets timeout /
          // cancel actually stop the sub-call instead of orphaning it.
          const res = await ctx.generate.text({ model, prompt }, { signal })
          const text = (res as { text?: unknown } | undefined)?.text
          if (typeof text !== "string" || text === "") throw new Error(`advisor model ${opts.advisor.providerID}/${opts.advisor.id} returned no text`)
          return text
        },
        persistUsage,
        log,
      }
      const engine = new AdvisorEngine(opts, host)
      // Hook/tool registrations must be disposed on unload — otherwise a
      // plugin reload leaks callbacks and injections fire repeatedly.
      const regs: Array<{ dispose(): Promise<void> }> = []
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
              if (!r.ok) {
                log("warn", `consult failed: ${r.errorCode} — ${r.message}`)
                return { content: `advisor_tool_result_error: ${r.errorCode} — ${r.message}` }
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

      // --- 2) task reset on admitted user prompts ------------------------
      try {
        const reg2 = await ctx.session.hook("prompt", (event: any) => {
          const sid = String(event?.sessionID ?? "")
          if (sid) engine.resetTask(sid)
        })
        regs.push(reg2)
      } catch (err) {
        log("warn", "prompt hook registration failed (per-task caps degrade to per-session)", err)
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
            // canInject: flags latch only when the system array is actually writable,
            // so a non-array event.system retries next call instead of losing the
            // injection for the whole task. Eligibility is lazy so tier regexes
            // run only when a nudge is actually on the table.
            const canInject = Array.isArray(event?.system)
            const d = engine.noteStep(sid, () => shouldNudgeExecutor(modelId, opts.nudge), canInject)
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

      // --- 4) self-probe: prove the tool is actually registered ----------
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
