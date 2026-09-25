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

import { readFile, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { AdvisorEngine } from "./engine.js"
import { resolveOptions, shouldNudgeExecutor } from "./options.js"
import { ADVISOR_TOOL_DESCRIPTION, EXECUTOR_TIMING_PROMPT, NUDGE_TEXT } from "./prompts.js"
import { PLUGIN_ID, PLUGIN_VERSION } from "./types.js"
import type { AdvisorOptions, Host, Slice, UsageEntry } from "./types.js"
import { callAdvisorProvider } from "./providers.js"

const USAGE_DIR = join(homedir(), ".cache", "opencode-advisor")
const USAGE_FILE = join(USAGE_DIR, "usage.json")

type UsageFile = Record<string, UsageEntry>

async function persistUsageFile(entry: UsageEntry): Promise<void> {
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
  await writeFile(USAGE_FILE, JSON.stringify(all, null, 2), "utf8")
}

/** V1 transcript: client.session.messages → {info, parts}[] (shape varies by version). */
function normalizeV1Messages(messages: unknown): Slice[] {
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
        const state = part.state as Record<string, unknown> | undefined
        const payload =
          (typeof state?.output === "string" && state.output) ||
          (typeof state?.input === "string" && state.input) ||
          (typeof part.output === "string" && part.output) ||
          ""
        if (payload) out.push({ role: "tool", name: typeof part.tool === "string" ? part.tool : "unknown", text: payload })
      }
    }
  }
  return out
}

async function makeV1Tool(engine: AdvisorEngine, log: (msg: string) => void): Promise<Record<string, unknown>> {
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
      return r.ok ? r.advice : `advisor_tool_result_error: ${r.errorCode} — ${r.message}`
    },
  }
}

export async function createV1Hooks(input: unknown, options?: unknown): Promise<Record<string, unknown>> {
  const ctx = input as { client?: any } | undefined
  const log = (msg: string): void => console.log(`[${PLUGIN_ID}] ${msg}`)

  let opts: AdvisorOptions
  try {
    opts = resolveOptions(options ?? {})
  } catch (err) {
    console.error(`[${PLUGIN_ID}] CONFIG ERROR (v1 adapter): ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  const host: Host = {
    getTranscript: async (sessionID) => {
      const client = ctx?.client
      if (!client?.session) throw new Error("v1 host has no session client")
      // V1 SDK shapes vary; try the documented call forms in order.
      const messages = await (client.session.messages?.({ path: { id: sessionID } }).catch(() =>
        client.session.messages?.({ query: { sessionID } }),
      ) ?? [])
      return normalizeV1Messages(messages)
    },
    runAdvisor: async (prompt, signal) => {
      if (!opts.source) {
        throw new Error(
          "v1 adapter requires a direct advisor source — set plugin option \"source\" { kind, baseURL, apiKeyEnv, model } " +
            "(or ADVISOR_SOURCE_KIND/URL/KEY_ENV/MODEL env vars)",
        )
      }
      return callAdvisorProvider(opts.source, prompt, opts.timeoutMs, signal)
    },
    persistUsage: (entry) => persistUsageFile(entry).catch(() => {}),
    log: (level, message, data) => {
      if (level === "error") console.error(`[${PLUGIN_ID}] ${message}`, data ?? "")
      else log(message)
    },
  }
  const engine = new AdvisorEngine(opts, host)

  log(`v1 adapter v${PLUGIN_VERSION} — advisor=${opts.advisor.providerID}/${opts.advisor.id}${opts.source ? ` source=${opts.source.kind}` : " (NO SOURCE — configure before use)"}`)

  return {
    "chat.message": async (inp: { sessionID?: string }) => {
      const sid = String(inp?.sessionID ?? "")
      if (sid) engine.resetTask(sid)
      else engine.resetTask("*")
    },
    "experimental.chat.system.transform": async (_inp: unknown, output: { system: string[] }) => {
      try {
        const d = engine.noteStep("*", undefined, shouldNudgeExecutor(undefined, opts.nudge))
        if (d.injectTiming && Array.isArray(output?.system)) output.system.push(EXECUTOR_TIMING_PROMPT)
        if (d.injectNudge && Array.isArray(output?.system)) output.system.push(NUDGE_TEXT)
      } catch (err) {
        log(`system transform failed (ignored): ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    tool: { advisor: await makeV1Tool(engine, log) },
  }
}
