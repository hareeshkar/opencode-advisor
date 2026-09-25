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
import { extractToolNames, replaceSystemInBody } from "./inject.js"
import { resolveOptions, shouldNudgeExecutor } from "./options.js"
import { ADVISOR_TOOL_DESCRIPTION, AGENT_MODE_PREFIX, EXECUTOR_TIMING_PROMPT, NUDGE_TEXT, TUI_CLAIM_KEY, advisorLabel, findTrigger, hasDirective, isAdvisorConfigured, isSettingsInvocation, shortlistAdvisorModels, triggerDirective } from "./prompts.js"
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

/** Last assistant text in a session message list (agent-mode advice extraction). */
export function extractLastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: unknown; content?: unknown } | undefined
    if (!m || String(m.type ?? "") !== "assistant") continue
    if (!Array.isArray(m.content)) continue
    const texts: string[] = []
    for (const c of m.content) {
      const part = c as { type?: unknown; text?: unknown }
      if (part && part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        texts.push(part.text)
      }
    }
    if (texts.length > 0) return texts.join("\n").trim()
  }
  return ""
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

      if (!isAdvisorConfigured(opts.advisor)) {
        // Safe-by-default: fresh installs load UNCONFIGURED (zero spend).
        // The advisor tool stays registered and answers with setup steps;
        // /advisor-settings or the opencode.json option configures it.
        console.warn(
          `[${PLUGIN_ID}] no advisor model configured yet — the advisor tool will return setup steps until one is set (via /advisor-settings or the plugin's "advisor" option).`,
        )
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
        runAdvisor: async (prompt, signal, sessionID, nonce, model) => {
          // AGENT MODE: the advisor runs as a READ-ONLY child session (plan
          // agent, advisor model, deny edit/shell) that may make multiple
          // tool calls to verify claims before advising — Anthropic's
          // principle (full-transcript strategy) plus grounded exploration.
          if (opts.advisorMode === "agent") {
            return runAdvisorAgent(prompt, model)
          }
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
            providerID: model.providerID,
            id: model.id,
          }
          if (model.variant) advisorRef.variant = model.variant
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
      // Child sessions spawned by AGENT-MODE advisor consults. Used as a
      // recursion guard: a consult originating inside one of these returns
      // an error instead of spawning another child (bounded depth).
      const advisorChildSessions = new Set<string>()
      /** AGENT MODE: read-only child session that investigates, then advises. */
      const runAdvisorAgent = async (
        prompt: string,
        model: { providerID: string; id: string; variant?: string },
      ): Promise<string> => {
        const created = (await ctx.session.create({
          title: "advisor consult",
          agent: "plan",
          model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) },
          permissions: [
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
            { action: "subagent", resource: "*", effect: "deny" },
          ],
        })) as { id?: unknown } | undefined
        const childID = String((created as { id?: unknown })?.id ?? "")
        if (childID === "") throw new Error("agent-mode advisor: child session creation returned no id")
        advisorChildSessions.add(childID)
        try {
          await ctx.session.prompt({ sessionID: childID, text: `${AGENT_MODE_PREFIX}${prompt}` })
          // Poll to completion (idle message marks the end of the run).
          const deadline = Date.now() + opts.timeoutMs
          let lastText = ""
          for (;;) {
            if (Date.now() > deadline) throw new Error(`agent-mode advisor timed out after ${opts.timeoutMs}ms`)
            await new Promise((r) => setTimeout(r, 1_500))
            let messages: unknown[] = []
            try {
              messages = (await ctx.session.context({ sessionID: childID })) as unknown[]
            } catch {
              /* transient read failure — retry until deadline */
              continue
            }
            const text = extractLastAssistantText(messages)
            if (text !== "") lastText = text
            const last = messages[messages.length - 1] as { type?: unknown } | undefined
            if (last && String(last.type ?? "") === "idle") return lastText
          }
        } finally {
          advisorChildSessions.delete(childID)
          try {
            await (ctx.session as { remove?: (input: { sessionID: string }) => Promise<void> }).remove?.({ sessionID: childID })
          } catch {
            /* cleanup is best-effort; a stray read-only session is harmless */
          }
        }
      }

      // Hook/tool/RPC registrations must be disposed on unload — otherwise a
      // plugin reload leaks callbacks and injections fire repeatedly.
      const regs: Array<{ dispose(): Promise<void> }> = []
      // Handle for the settings command so a TUI claim can dispose it.
      let settingsRegistration: { dispose(): Promise<void> } | undefined
      // Does the TUI plugin own /advisor-settings? (persisted claim)
      let tuiClaimed = false
      try {
        tuiClaimed = (await ctx.storage.get(TUI_CLAIM_KEY)) === true
      } catch {
        /* storage unavailable — assume no claim */
      }
      // Transient consult directives (trigger words / /advisor) — delivered
      // as invisible system text on the next primary model call, never
      // written into the user's message (no conversation bloat, no
      // persisted boilerplate). TTL guards against stale deliveries.
      // INSTANCE identifies this plugin instance in diagnostics (multiple
      // instances can exist per location set; per-instance closures must
      // never be assumed to be shared).
      const INSTANCE = Math.random().toString(36).slice(2, 8)
      const pendingDirectives = new Map<string, { text: string; at: number }>()
      const DIRECTIVE_TTL_MS = 15 * 60_000
      const diagDirective = (action: string, sessionID: string, extra?: Record<string, unknown>): void => {
        try {
          const key = `diag:directive:${sessionID}`
          void (async () => {
            const prev = ((await ctx.storage.get(key)) as unknown[] | undefined) ?? []
            const next = [...prev, { action, instance: INSTANCE, at: Date.now(), steps: engine.health(sessionID).steps, ...extra }].slice(-20)
            await ctx.storage.set(key, next).catch(() => {})
          })().catch(() => {})
        } catch {
          /* diagnostics only */
        }
      }
      // Transient system guidance awaiting native delivery: queued by the
      // context hook, injected into the outgoing request body by the
      // http.request hook (the only channel that reaches the model on
      // v2.0.16). TTL-guarded; idempotent via the injection sentinel.
      // Each pending batch carries a FRESH random marker: a stable sentinel
      // can already exist in transcripts (this very project discusses it),
      // which silently disabled injection (observed via diag "http-already").
      const pendingSystem = new Map<string, { texts: string[]; marker: string; at: number }>()
      const queueSystemInjection = (sessionID: string, texts: string[]): void => {
        const prev = pendingSystem.get(sessionID)
        const merged = prev ? [...prev.texts, ...texts] : texts
        pendingSystem.set(sessionID, { texts: merged.slice(-6), marker: `<<advisor-plugin:${Math.random().toString(36).slice(2, 12)}>>`, at: Date.now() })
      }
      const takeSystemInjection = (sessionID: string): { texts: string[]; marker: string } | undefined => {
        const p = pendingSystem.get(sessionID)
        if (!p) return undefined
        pendingSystem.delete(sessionID)
        return Date.now() - p.at > DIRECTIVE_TTL_MS ? undefined : { texts: p.texts, marker: p.marker }
      }
      const takeDirective = (sessionID: string): string | undefined => {
        const d = pendingDirectives.get(sessionID)
        if (!d) return undefined
        pendingDirectives.delete(sessionID)
        return Date.now() - d.at > DIRECTIVE_TTL_MS ? undefined : d.text
      }
      // Runtime advisor override (set via /advisor-settings). Persisted in
      // plugin storage; wins over the opencode.json option until reset.
      let overrideActive = false
      try {
        const saved = (await ctx.storage.get("advisor:override")) as
          | { providerID?: unknown; id?: unknown; variant?: unknown }
          | undefined
        if (saved && typeof saved.providerID === "string" && typeof saved.id === "string" && saved.providerID !== "") {
          engine.setAdvisor({
            providerID: saved.providerID,
            id: saved.id,
            ...(typeof saved.variant === "string" ? { variant: saved.variant } : {}),
          })
          overrideActive = true
          log("info", `advisor override active: ${advisorLabel(engine.advisor())}`)
        }
      } catch {
        /* storage unavailable — stay on config default */
      }
      const persistAdvisorOverride = async (
        ref: { providerID: string; id: string; variant?: string } | null,
      ): Promise<void> => {
        if (ref === null) {
          overrideActive = false
          engine.setAdvisor(opts.advisor)
          await ctx.storage.remove("advisor:override").catch(() => {})
          log("info", `advisor override cleared — back to ${advisorLabel(engine.advisor())}`)
          return
        }
        engine.setAdvisor(ref)
        overrideActive = true
        await ctx.storage.set("advisor:override", engine.advisor()).catch(() => {})
        log("info", `advisor set to ${advisorLabel(engine.advisor())} (override persisted)`)
      }
      // RPC surface for the TUI settings picker (and any client). Plain
      // portable definition — no runtime dependency on @opencode/plugin/rpc.
      try {
        const regRpc = await ctx.rpc.register(
          {
            id: "opencode-advisor",
            methods: {
              get: {
                input: { type: "object", properties: {}, additionalProperties: false },
                output: {
                  type: "object",
                  properties: {
                    providerID: { type: "string" },
                    id: { type: "string" },
                    variant: { type: "string" },
                    source: { type: "string" },
                  },
                  required: ["providerID", "id", "source"],
                  additionalProperties: false,
                },
              },
              set: {
                input: {
                  type: "object",
                  properties: {
                    providerID: { type: "string" },
                    id: { type: "string" },
                    variant: { type: "string" },
                  },
                  required: ["providerID", "id"],
                  additionalProperties: false,
                },
                output: {
                  type: "object",
                  properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } },
                  required: ["providerID", "id"],
                  additionalProperties: false,
                },
              },
              reset: {
                input: { type: "object", properties: {}, additionalProperties: false },
                output: {
                  type: "object",
                  properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } },
                  required: ["providerID", "id"],
                  additionalProperties: false,
                },
              },
              "claim": {
                input: { type: "object", properties: {}, additionalProperties: false },
                output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
              },
            },
            events: {},
          },
          {
            get: async () => {
              const ref = engine.advisor()
              return {
                providerID: ref.providerID,
                id: ref.id,
                ...(ref.variant ? { variant: ref.variant } : {}),
                source: overrideActive ? "override" : "config",
              }
            },
            set: async (input: any) => {
              const providerID = String(input?.providerID ?? "")
              const id = String(input?.id ?? "")
              const variant = typeof input?.variant === "string" && input.variant !== "" ? String(input.variant) : undefined
              if (providerID === "" || id === "") throw new Error("advisor.set requires providerID and id")
              await persistAdvisorOverride({ providerID, id, ...(variant ? { variant } : {}) })
              const ref = engine.advisor()
              return { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
            },
            reset: async () => {
              await persistAdvisorOverride(null)
              const ref = engine.advisor()
              return { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
            },
            "claim": async () => {
              try {
                await ctx.storage.set(TUI_CLAIM_KEY, true)
              } catch {
                /* storage unavailable — claim is best-effort */
              }
              if (settingsRegistration) {
                try {
                  await settingsRegistration.dispose()
                } catch {
                  /* already disposed */
                }
                settingsRegistration = undefined
              }
              log("info", "TUI claimed /advisor-settings — native picker active, server flow suppressed")
              return { ok: true }
            },
          },
        )
        regs.push(regRpc)
      } catch (err) {
        log("warn", "RPC registration failed (TUI settings picker will be unavailable; executor settings flow still works)", err)
      }
      // Hook/tool registrations must be disposed on unload — otherwise a
      // plugin reload leaks callbacks and injections fire repeatedly.
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
              if (advisorChildSessions.has(sessionID)) {
                return {
                  content:
                    "advisor_tool_result_error: unavailable — nested advisor sessions are not supported. You ARE the advisor: answer with your guidance.",
                }
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
              return { content: frameAdvice(r.advice, advisorLabel(engine.advisor())) }
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
      // Trigger words (advice/advisor/get consultation, configurable) queue
      // a TRANSIENT consult directive — delivered as invisible system text
      // on the next primary model call, never written into the user's
      // message. The visible conversation stays clean; nothing is persisted
      // into history or compaction.
      try {
        const reg2 = await ctx.session.hook("prompt", (event: any) => {
          try {
            const sid = String(event?.sessionID ?? "")
            if (sid) engine.resetTask(sid)
            const text = typeof event?.prompt?.text === "string" ? event.prompt.text : ""
            if (
              sid !== "" &&
              text !== "" &&
              !hasDirective(text) &&
              !isSettingsInvocation(text) &&
              !pendingDirectives.has(sid)
            ) {
              const matched = findTrigger(text, opts.triggers)
              if (matched) {
                pendingDirectives.set(sid, { text: triggerDirective(matched), at: Date.now() })
                diagDirective("queued", sid, { trigger: matched, via: "prompt-hook" })
                log("info", `advisor trigger "${matched}" — directive queued (transient system delivery)`)
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
      // The user's visible prompt stays minimal (their focus, or one short
      // line); the consult directive travels as transient system text.
      try {
        const regCmd = await ctx.command.transform((editor: any) => {
          editor.add({
            name: "advisor",
            description: "Consult the high-judgment advisor model about the current task or a focus question.",
            execute: async ({ sessionID, prompt, delivery }: any) => {
              const focus = String(prompt?.text ?? "").trim()
              if (sessionID && !pendingDirectives.has(sessionID)) {
                pendingDirectives.set(sessionID, { text: triggerDirective("/advisor", "command"), at: Date.now() })
                diagDirective("queued", sessionID, { trigger: "/advisor", via: "command" })
              }
              await ctx.session.prompt({
                sessionID,
                text: focus !== "" ? focus : "Review the current task with the advisor.",
                delivery,
              })
            },
          })
        })
        regs.push(regCmd)
      } catch (err) {
        log("warn", "/advisor command registration failed (trigger words still work)", err)
      }

      // --- 2c) /advisor-settings slash command (executor fallback) --------
      // Guided advisor-model selection for hosts WITHOUT the CLI plugin:
      // the plugin renders a token-lean shortlist, the executor asks via the
      // native question tool, and writes the choice into opencode.json
      // (transparent diff, hot-reload applies it). When the TUI plugin has
      // claimed the UI (storage flag), this flow is skipped so there is
      // exactly one /advisor-settings entry (the native picker).
      if (tuiClaimed) {
        log("info", "TUI owns /advisor-settings — executor settings flow skipped")
      } else {
        try {
          const regSettings = await ctx.command.transform((editor: any) => {
          editor.add({
            name: "advisor-settings",
            description: "Choose the advisor model and variant via a guided question flow.",
            execute: async ({ sessionID, prompt, delivery }: any) => {
              let rendered = "(catalog unavailable — ask the user to name a configured provider/model)";
              try {
                const models = (await ctx.model.list()) as any
                const list = Array.isArray(models) ? models : (models?.data ?? [])
                const clean = (Array.isArray(list) ? list : [])
                  .map((m: any) => ({
                    providerID: String(m?.providerID ?? ""),
                    id: String(m?.id ?? ""),
                    name: typeof m?.name === "string" ? m.name : "",
                  }))
                  .filter((m) => m.providerID !== "" && m.id !== "")
                const entries = shortlistAdvisorModels(clean, engine.advisor())
                if (entries.length > 0) {
                  rendered = entries
                    .map(
                      (m) =>
                        `- ${m.providerID}/${m.id}${m.name !== "" ? ` — ${m.name}` : ""}${m.current ? " (current, Recommended)" : ""}`,
                    )
                    .join("\n")
                }
              } catch (err) {
                log("warn", "advisor-settings: model catalog unreadable", err)
              }
              const focus = String(prompt?.text ?? "").trim()
              await ctx.session.prompt({
                sessionID,
                text: [
                  "The user opened advisor settings. Keep it token-lean — do NOT list the full model catalog.",
                  "1. Ask which advisor model they want via the question tool with EXACTLY these options (the tool also accepts a typed custom answer):",
                  rendered,
                  '2. Then ask which variant/thinking effort they want (or "default"/none).',
                  "3. Write their choice into the \"advisor\" option of the opencode-advisor plugin entry in the opencode.json file that contains it (usually ~/.config/opencode/opencode.json) as { \"providerID\": \"...\", \"id\": \"...\" } plus \"variant\" only if they chose one. Edit ONLY that field — read the file first, preserve every other key, and re-read to verify.",
                  "4. Confirm the switch as provider/model[#variant] and note it applies from the next consultation (config hot-reloads).",
                  `User focus: ${focus !== "" ? focus : "(none)"}`,
                ].join("\n"),
                delivery,
              })
            },
          })
        })
        regs.push(regSettings)
        settingsRegistration = regSettings
        } catch (err) {
          log("warn", "/advisor-settings command registration failed", err)
        }
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
            // Unconfigured installs inject nothing: no timing guidance for a
            // tool that would only return setup steps (token discipline).
            const d = isAdvisorConfigured(engine.advisor())
              ? engine.noteStep(sid, () => shouldNudgeExecutor(modelId, opts.nudge), canInject)
              : { injectTiming: false, injectNudge: false }
            // Permanent hook-delivery census: one tiny write on each session's
            // first model call (last-write-wins single key — bounded). Lets
            // post-hoc analysis prove hooks fire in any session type
            // (one-shot `run`, subagents, TUI) without per-call amplification.
            // The richer `diag:ctx` write additionally records the SHAPE of
            // the context event (canInject depends on system being an array).
            if (engine.health(sid).steps === 1) {
              try {
                void ctx.storage.set("diag:hookcheck", { sessionID: sid, time: Date.now() }).catch(() => {})
                void ctx.storage
                  .set("diag:ctx", {
                    sessionID: sid,
                    kind: String(event?.kind ?? "?"),
                    systemIsArray: Array.isArray(event?.system),
                    systemLength: Array.isArray(event?.system) ? event.system.length : -1,
                    keys: Object.keys(event ?? {}).slice(0, 15),
                    at: Date.now(),
                  })
                  .catch(() => {})
              } catch {
                /* diagnostics only */
              }
            }
            // Transient guidance is QUEUED here, not pushed into
            // event.system: v2.0.16 does not deliver context-hook system
            // mutations to the provider (verified with an in-band canary).
            // Delivery happens in the http.request hook by rewriting the
            // outgoing body (native, request-level).
            {
              const directive = takeDirective(sid)
              const injections: string[] = []
              if (directive) injections.push(directive)
              if (d.injectTiming) injections.push(EXECUTOR_TIMING_PROMPT)
              if (d.injectNudge) injections.push(NUDGE_TEXT)
              if (injections.length > 0) {
                queueSystemInjection(sid, injections)
              }
              diagDirective("context", sid, {
                queued: injections.length,
                directive: directive !== undefined,
                timing: d.injectTiming,
                nudge: d.injectNudge,
                kind: String(event?.kind ?? "(none)"),
              })
            }
          } catch (err) {
            log("warn", "context hook body failed (ignored — model call proceeds)", err)
          }
        })
        regs.push(reg3)
      } catch (err) {
        log("warn", "context hook registration failed (timing prompt will not be injected)", err)
      }

      // --- 4) native request rewrite: session header + transient system ----
      // Fires for every native provider request a session issues. Two jobs:
      //  a) correlate advisor sub-calls by their evidence nonce and attach
      //     x-opencode-session (routing; enables provider prompt caching)
      //  b) inject queued transient system guidance into PRIMARY request
      //     bodies — the only channel that reaches the model on v2.0.16
      //     (context-hook system mutations are silently dropped).
      // Idempotent via the injection sentinel; queued texts are consumed
      // only after a successful rewrite.
      try {
        const regHttp = await Promise.race([
          ctx.session.hook("http.request", async (event: any) => {
            try {
              if (opts.logLevel === "debug") {
                httpHookLive = true
                observedKinds.add(String(event?.kind ?? "?"))
              }
              const sid = String(event?.sessionID ?? "")
              const kind = String(event?.kind ?? "")
              const hasPendingSystem = sid !== "" && kind === "primary" && pendingSystem.has(sid)
              if (pendingAdvisorCalls.size === 0 && !hasPendingSystem) return
              const req = event?.request as
                | { clone(): { text(): Promise<string> }; headers: { set(k: string, v: string): void }; url?: string; method?: string }
                | undefined
              if (!req || typeof req.clone !== "function") return

              // (b) transient system injection for primary requests
              if (hasPendingSystem) {
                const batch = takeSystemInjection(sid)
                if (batch && batch.texts.length > 0) {
                  const texts = batch.texts
                  const bodyText = await req.clone().text().catch(() => "")
                  if (bodyText) {
                    const result = replaceSystemInBody(bodyText, texts, batch.marker)
                    if (result && typeof event.request !== "undefined") {
                      const original = event.request as Request
                      event.request = new Request(original.url, {
                        method: original.method,
                        headers: new Headers(original.headers),
                        body: result.body,
                      })
                      diagDirective("http-injected", sid, { format: result.format, blocks: texts.length })
                      // Proof-of-delivery diagnostics: which tools were
                      // actually offered, and was the advisor among them?
                      // (Settles infrastructure-vs-compliance questions.)
                      try {
                        const toolNames = extractToolNames(bodyText)
                        const advisorTool = toolNames.find((n) => n === "advisor" || n.endsWith("_advisor") || n.includes("advisor")) ?? null
                        void ctx.storage
                          .set(`diag:injected:${sid}`, {
                            advisorPresent: advisorTool !== null,
                            advisorToolName: advisorTool,
                            toolsCount: toolNames.length,
                            toolsSample: toolNames.slice(0, 12),
                            sentinel: result.body.includes(batch.marker),
                            format: result.format,
                            at: Date.now(),
                          })
                          .catch(() => {})
                      } catch {
                        /* diagnostics only */
                      }
                    } else {
                      // Never silently drop: re-queue with a FRESH marker for
                      // the next attempt (unknown shape / already-present).
                      queueSystemInjection(sid, texts)
                      diagDirective("http-skip", sid, { bodyLength: bodyText.length, alreadyPresent: bodyText.includes(batch.marker) })
                    }
                  } else {
                    queueSystemInjection(sid, texts)
                  }
                }
              }

              // (a) advisor sub-call routing header via nonce correlation
              if (pendingAdvisorCalls.size > 0) {
                const body = await req.clone().text().catch(() => "")
                if (body) {
                  for (const [nonce, advisorSid] of pendingAdvisorCalls) {
                    if (body.includes(nonce)) {
                      req.headers.set("x-opencode-session", advisorSid)
                      nonceMatches++
                      log("debug", `attached x-opencode-session for advisor sub-call (kind=${kind})`)
                      break
                    }
                  }
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
