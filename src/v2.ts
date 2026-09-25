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
import { PLUGIN_ID, PLUGIN_VERSION } from "./types.js"
import type { AdvisorOptions, Host, LogLevel, Slice, UsageEntry } from "./types.js"

/* ------------------------------------------------------------------ */
/* transcript normalization                                            */
/* ------------------------------------------------------------------ */

/** Best-effort text extraction from arbitrary tool-state payloads. */
function toText(v: unknown, depth = 0): string {
  if (typeof v === "string") return v
  if (v === null || v === undefined || typeof v !== "object" || depth > 2) return ""
  const rec = v as Record<string, unknown>
  for (const key of ["text", "output", "content", "result", "data"]) {
    if (key in rec) {
      const s = toText(rec[key], depth + 1)
      if (s) return s
    }
  }
  if (Array.isArray(rec.content)) return rec.content.map((c) => toText(c, depth + 1)).filter(Boolean).join("\n")
  return ""
}

function toolSlice(name: unknown, part: unknown): Slice | undefined {
  const state = (part as { state?: unknown })?.state
  const candidates = Array.isArray(state) ? state : [state]
  for (const c of candidates) {
    const rec = c as Record<string, unknown> | undefined
    if (!rec || typeof rec !== "object") continue
    for (const key of ["output", "result", "input", "args", "command", "content", "text"]) {
      const s = toText(rec[key])
      if (s) return { role: "tool", name: typeof name === "string" ? name : "unknown", text: s }
    }
  }
  // last resort: bounded JSON of whatever the state holds
  try {
    const json = JSON.stringify(state)
    if (json && json !== "{}" && json !== "null") {
      return { role: "tool", name: typeof name === "string" ? name : "unknown", text: json.slice(0, 400) }
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
      const text = typeof msg.text === "string" ? msg.text : toText(msg.content) ?? toText(msg.parts)
      if (text) out.push({ role: "user", name: type === "synthetic" ? "synthetic" : undefined, text })
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

      const log = (level: LogLevel, message: string, data?: unknown): void => {
        const line = `[${PLUGIN_ID}] ${message}`
        if (level === "error") console.error(line, data ?? "")
        else if (level === "warn") console.warn(line, data ?? "")
        else if (opts.logLevel === "debug" || level === "info") console.log(line, data ?? "")
        void 0
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
        runAdvisor: async (prompt) => {
          const model: Record<string, string> = { providerID: opts.advisor.providerID, id: opts.advisor.id }
          if (opts.advisor.variant) model.variant = opts.advisor.variant
          const res = await ctx.generate.text({ model, prompt })
          const text = (res as { text?: unknown } | undefined)?.text
          if (typeof text !== "string" || text === "") throw new Error(`advisor model ${opts.advisor.providerID}/${opts.advisor.id} returned no text`)
          return text
        },
        persistUsage,
        log,
      }
      const engine = new AdvisorEngine(opts, host)

      // --- 1) the zero-arg advisor tool ---------------------------------
      try {
        await ctx.tool.transform((editor: any) => {
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
              return { content: r.advice }
            },
          })
        })
      } catch (err) {
        log("error", "FAILED to register advisor tool — plugin non-functional", err)
        throw err
      }

      // --- 2) task reset on admitted user prompts ------------------------
      try {
        await ctx.session.hook("prompt", (event: any) => {
          const sid = String(event?.sessionID ?? "")
          if (sid) engine.resetTask(sid)
        })
      } catch (err) {
        log("warn", "prompt hook registration failed (per-task caps degrade to per-session)", err)
      }

      // --- 3) transient system injection (timing + nudge) -----------------
      try {
        await ctx.session.hook("context", (event: any) => {
          try {
            const sid = String(event?.sessionID ?? "")
            const modelRef = event?.model
            const modelId = modelRef ? `${String(modelRef.providerID ?? "")}/${String(modelRef.id ?? "")}` : undefined
            const d = engine.noteStep(sid, modelId, shouldNudgeExecutor(modelId, opts.nudge))
            if (d.injectTiming && Array.isArray(event.system)) {
              event.system.push({ type: "text", text: EXECUTOR_TIMING_PROMPT })
            }
            if (d.injectNudge && Array.isArray(event.system)) {
              event.system.push({ type: "text", text: NUDGE_TEXT })
            }
          } catch (err) {
            log("warn", "context hook body failed (ignored — model call proceeds)", err)
          }
        })
      } catch (err) {
        log("warn", "context hook registration failed (timing prompt will not be injected)", err)
      }

      // --- 4) self-probe: prove the tool is actually registered ----------
      try {
        const tools = await ctx.tool.list()
        const ok = Array.isArray(tools) && tools.some((t: any) => String(t?.id ?? t?.name ?? "") === "advisor")
        if (ok) {
          log("info", `ready v${PLUGIN_VERSION} — tool=✓ advisor=${opts.advisor.providerID}/${opts.advisor.id} maxUses/task=${opts.maxUsesPerTask} budget=${opts.adviceWordBudget}w`)
        } else {
          log("error", "SELF-PROBE FAILED: advisor tool absent from registry after transform — it will not be callable. Report at github.com/hareeshkar/opencode-advisor")
        }
      } catch (err) {
        log("warn", "self-probe could not list tools", err)
      }

      return () => log("info", `unloaded v${PLUGIN_VERSION}`)
    },
  }
}
