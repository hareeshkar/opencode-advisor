/**
 * V1 adapter (OpenCode 1.x ≥ 1.18.29) — EXPERIMENTAL.
 *
 * V2 is the verified path. This adapter exists so one package can serve
 * legacy runtimes via the officially documented dual-export pattern
 * (`setup()` for V2, `server()` for V1). Known V1 limitations, handled
 * defensively:
 *   - no transient generate primitive → advisor sub-calls go direct to the
 *     provider over HTTP (see providers.ts); requires `source` config
 *   - system transform has no reliable sessionID → step gating uses a
 *     single bucket keyed "*"; per-task caps degrade to per-session for
 *     concurrent sessions
 *   - tool args use zod in the host; we import zod lazily and fall back to
 *     a plain empty-object schema if it is unavailable
 */

import { readFile, mkdir, writeFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { AdvisorEngine } from "./engine.js"
import { resolveOptions, shouldNudgeExecutor } from "./options.js"
import { ADVISOR_TOOL_DESCRIPTION, EXECUTOR_TIMING_PROMPT, NUDGE_TEXT, advisorLabel, findTrigger, hasDirective, isSettingsInvocation, triggerDirective } from "./prompts.js"
import { frameAdvice } from "./sanitize.js"
import { PLUGIN_ID, PLUGIN_VERSION } from "./types.js"
import type { AdvisorOptions, Host, Slice, UsageEntry } from "./types.js"
import { callAdvisorProvider } from "./providers.js"

const USAGE_DIR = join(homedir(), ".cache", "opencode-advisor")
const USAGE_FILE = join(USAGE_DIR, "usage.json")
const USAGE_TMP = join(USAGE_DIR, "usage.json.tmp")

type UsageFile = Record<string, UsageEntry>

// Serialized read-modify-write (plus atomic tmp+rename) so concurrent
// consults can't clobber each other's ledger entries.
let usageChainV1: Promise<void> = Promise.resolve()

function persistUsageFile(entry: UsageEntry): Promise<void> {
  usageChainV1 = usageChainV1
    .then(async () => {
      let all: UsageFile = {}
      try {
        all = JSON.parse(await readFile(USAGE_FILE, "utf8")) as UsageFile
      } catch {
        /* fresh file */
      }
      const prev = all[entry.date]
      all[entry.date] = prev
        ? {
            date: entry.date,
            calls: prev.calls + entry.calls,
            errors: prev.errors + entry.errors,
            estTokensIn: prev.estTokensIn + entry.estTokensIn,
            estTokensOut: prev.estTokensOut + entry.estTokensOut,
            adviceChars: prev.adviceChars + entry.adviceChars,
          }
        : entry
      await mkdir(USAGE_DIR, { recursive: true })
      await writeFile(USAGE_TMP, JSON.stringify(all, null, 2), "utf8")
      await rename(USAGE_TMP, USAGE_FILE)
    })
    .catch(() => {})
  return usageChainV1
}

/** V1 transcript: client.session.messages → {info, parts}[] (shape varies by version). */
export function normalizeV1Messages(messages: unknown): Slice[] {
  const out: Slice[] = []
  if (!Array.isArray(messages)) return out
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue
    const rec = m as Record<string, unknown>
    const info = (rec.info ?? rec) as Record<string, unknown>
    const role = String(info.role ?? rec.role ?? "")
    const parts = (rec.parts ?? info.parts ?? rec.content ?? []) as unknown
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      const part = p as Record<string, unknown>
      if (part === null || typeof part !== "object") continue
      const t = part.type
      if (t === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        out.push({ role: role === "assistant" ? "assistant" : "user", text: part.text })
      } else if (t === "tool") {
        const state = (part.state ?? {}) as Record<string, unknown>
        const status = state.status
        // Partial states are not evidence; error states surface the message.
        if (status === "streaming" || status === "running") continue
        let payload = ""
        if (status === "error") {
          const err = state.error as { message?: unknown } | undefined
          payload = err && typeof err.message === "string" ? `[error] ${err.message}` : ""
        } else {
          payload =
            (typeof state.output === "string" && state.output) ||
            (typeof state.input === "string" && state.input) ||
            (typeof part.output === "string" && part.output) ||
            ""
        }
        if (payload) out.push({ role: "tool", name: typeof part.tool === "string" ? part.tool : "unknown", text: payload })
      }
    }
  }
  return out
}

async function makeV1Tool(engine: AdvisorEngine, log: (msg: string) => void, opts: AdvisorOptions): Promise<Record<string, unknown>> {
  let args: unknown = {}
  try {
    const { z } = (await import("zod")) as { z: { object: (s: Record<string, never>) => unknown } }
    args = z.object({})
  } catch {
    log("zod unavailable in host — using plain empty args schema")
  }
  return {
    description: ADVISOR_TOOL_DESCRIPTION,
    args,
    execute: async (_args: unknown, tctx: { sessionID?: string; abort?: AbortSignal }) => {
      const sessionID = String(tctx?.sessionID ?? "")
      const signal = tctx?.abort ?? new AbortController().signal
      const r = await engine.consult(sessionID, signal)
      return r.ok ? frameAdvice(r.advice, advisorLabel(opts)) : `advisor_tool_result_error: ${r.errorCode} — ${r.message}`
    },
  }
}

export async function createV1Hooks(input: unknown, options?: unknown): Promise<Record<string, unknown>> {
  const ctx = input as { client?: any } | undefined

  let opts: AdvisorOptions
  try {
    opts = resolveOptions(options ?? {})
  } catch (err) {
    console.error(`[${PLUGIN_ID}] CONFIG ERROR (v1 adapter): ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
  const INFO_ENABLED = opts.logLevel === "debug" || opts.logLevel === "info"
  const log = (msg: string): void => {
    if (INFO_ENABLED) console.log(`[${PLUGIN_ID}] ${msg}`)
  }
  if (opts.advisor.variant) {
    console.warn(`[${PLUGIN_ID}] v1 adapter ignores advisor.variant "${opts.advisor.variant}" (direct provider calls use source.model)`)
  }

  const host: Host = {
    getTranscript: async (sessionID) => {
      const fn = ctx?.client?.session?.messages
      if (typeof fn !== "function") throw new Error("v1 host has no session.messages client")
      let messages: unknown = []
      try {
        messages = await fn({ path: { id: sessionID } })
      } catch {
        messages = await fn({ query: { sessionID } })
      }
      return normalizeV1Messages(messages)
    },
    runAdvisor: async (prompt, signal, sessionID, _nonce) => {
      if (!opts.source) {
        throw new Error(
          "v1 adapter requires a direct advisor source — set plugin option \"source\" { kind, baseURL, apiKeyEnv, model } " +
            "(or ADVISOR_SOURCE_KIND/URL/KEY_ENV/MODEL env vars)",
        )
      }
      return callAdvisorProvider(opts.source, prompt, opts.timeoutMs, signal, {
        "x-opencode-session": sessionID,
      })
    },
    persistUsage: (entry) => persistUsageFile(entry).catch(() => {}),
    log: (level, message, data) => {
      if (level === "error") console.error(`[${PLUGIN_ID}] ${message}`, data ?? "")
      else log(message)
    },
  }
  const engine = new AdvisorEngine(opts, host)

  log(`v1 adapter v${PLUGIN_VERSION} — advisor=${opts.advisor.providerID}/${opts.advisor.id}${opts.source ? ` source=${opts.source.kind}` : " (NO SOURCE — configure before use)"}`)

  // The system transform carries no reliable sessionID, so track the most
  // recent session from the hooks that do have it. Residual limitation:
  // truly concurrent V1 sessions share one step bucket (V2 is the fix).
  let currentSession = "*"

  return {
    "chat.message": async (inp: { sessionID?: string }, output?: { parts?: unknown }) => {
      const sid = String(inp?.sessionID ?? "")
      currentSession = sid || "*"
      engine.resetTask(currentSession)
      // Trigger-word routing: scan text parts (V1 UserMessage carries no
      // text field — prose lives in parts) and append the consult directive
      // to the LAST text part in place (no new part → no id assignment
      // issues with the server's message validation).
      try {
        const parts = Array.isArray(output?.parts) ? (output as { parts: unknown[] }).parts : []
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i] as { type?: unknown; text?: unknown }
          if (p !== null && typeof p === "object" && p.type === "text" && typeof p.text === "string") {
            if (!hasDirective(p.text) && !isSettingsInvocation(p.text)) {
              const matched = findTrigger(p.text, opts.triggers)
              if (matched) {
                p.text = `${p.text}\n\n${triggerDirective(matched)}`
                log(`advisor trigger "${matched}" — consult directive appended (v1 chat.message)`)
              }
            }
            break
          }
        }
      } catch (err) {
        log(`chat.message trigger scan failed (ignored): ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    "experimental.chat.system.transform": async (
      inp: { sessionID?: string; model?: { providerID?: unknown; provider?: unknown; id?: unknown; modelID?: unknown } },
      output: { system: string[] },
    ) => {
      try {
        const sid = (typeof inp?.sessionID === "string" && inp.sessionID) || currentSession
        currentSession = sid
        const m = inp?.model
        const modelId = m ? `${String(m.providerID ?? m.provider ?? "")}/${String(m.id ?? m.modelID ?? "")}` : undefined
        const canInject = Array.isArray(output?.system)
        const d = engine.noteStep(sid, () => shouldNudgeExecutor(modelId, opts.nudge), canInject)
        if (canInject) {
          if (d.injectTiming) output.system.push(EXECUTOR_TIMING_PROMPT)
          if (d.injectNudge) output.system.push(NUDGE_TEXT)
        }
      } catch (err) {
        log(`system transform failed (ignored): ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    tool: { advisor: await makeV1Tool(engine, log, opts) },
    // V1 has no command-registration API, so /advisor arrives as a user
    // command FILE (see commands/advisor.md) or any command named exactly
    // "advisor". Intercept here and append the directive to its submitted
    // parts (proven live refs from server source). Marker-guarded against
    // doubles when the command path also crosses chat.message. The
    // /advisor-settings command gets a catalog assist instead of a consult
    // directive (settings must never trigger spend).
    "command.execute.before": async (
      inp: { command?: string; sessionID?: string; arguments?: string },
      output?: { parts?: unknown },
    ) => {
      try {
        const cmd = String(inp?.command ?? "")
        if (cmd !== "advisor" && cmd !== "advisor-settings") return
        const parts = Array.isArray(output?.parts) ? (output as { parts: unknown[] }).parts : []
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i] as { type?: unknown; text?: unknown }
          if (p !== null && typeof p === "object" && p.type === "text" && typeof p.text === "string") {
            if (cmd === "advisor-settings") {
              if (!p.text.includes("[advisor-settings assist]")) {
                p.text =
                  `${p.text}\n\n[advisor-settings assist] Before asking, read the configured providers from the ` +
                  `opencode.json file containing the opencode-advisor plugin entry so the options you offer reflect reality.`
                log("advisor-settings command intercepted (v1 command.execute.before) — assist appended")
              }
            } else if (!hasDirective(p.text)) {
              p.text = `${p.text}\n\n${triggerDirective("/advisor")}`
              log("advisor command intercepted (v1 command.execute.before) — directive appended")
            }
            break
          }
        }
      } catch (err) {
        log(`command interception failed (ignored): ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
