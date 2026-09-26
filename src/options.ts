/**
 * Option resolution: defaults < environment < explicit plugin options.
 *
 * Every invalid value produces a loud, actionable error at load time —
 * never a silent fallback. (V2 plugin failures are known to be quiet;
 * we compensate by failing loudly wherever we can.)
 */

import { DEFAULT_TRIGGERS } from "./prompts.js"
import type { AdvisorModelRef, AdvisorOptions, AdvisorSource, LogLevel } from "./types.js"

const ENV = process.env as Record<string, string | undefined>

/** Dedicated config file names, lowest → highest precedence. */
export const CONFIG_FILE_RELATIVE = "opencode-advisor.json"

/** Shallow-merge config layers (later layers win per top-level key). Set
 *  whole nested objects (advisor/source) in one place to stay predictable. */
export function mergeAdvisorConfigLayers(layers: Array<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (layer === null || typeof layer !== "object" || Array.isArray(layer)) continue
    for (const [k, v] of Object.entries(layer as Record<string, unknown>)) {
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

/** Non-technical presets: a single word tunes the whole cost/quality curve.
 *  Tokens are the native unit: context tokens = what the advisor receives
 *  (converted to chars for the pruner at ~4 chars/token); advice tokens =
 *  the response budget instructed in the prompt and hard-capped at ~4
 *  chars/token. Numbers are deliberately generous — advice output is the
 *  cheapest part of a consult. */
export const PRESETS: Record<string, Partial<Record<string, unknown>>> = {
  economy: { maxUsesPerTask: 1, transcriptBudgetTokens: "8k", adviceTokenBudget: 4_000 },
  balanced: { maxUsesPerTask: 3, transcriptBudgetTokens: "16k", adviceTokenBudget: 8_000 },
  thorough: { maxUsesPerTask: 5, transcriptBudgetTokens: "32k", adviceTokenBudget: 16_000 },
  exhaustive: { maxUsesPerTask: 8, transcriptBudgetTokens: "64k", adviceTokenBudget: 32_000 },
}

export const DEFAULTS = {
  advisor: { providerID: "", id: "" } as AdvisorModelRef,
  maxUsesPerTask: 3,
  adviceTokenBudget: 8_000,
  advisorResponseWaitMs: 90_000,
  maxConsultMs: 3_600_000,
  maxToolOutputChars: 1_500,
  // 16k tokens ≈ 64k chars: balanced default — the recency-weighted excerpt
  // plus original-task pinning preserves signal at roughly ⅔ the cost of a
  // larger window (efficiency review F-ledger; tune per workload).
  transcriptBudgetTokens: 16_000,
  advisorMode: "review" as const,
  logLevel: "info" as const,
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function readString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

function readInt(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined
  const i = Math.floor(v)
  if (i < min || i > max) {
    throw new Error(`[advisor] option "${key}" must be between ${min} and ${max}, got ${v}`)
  }
  return i
}

/** Human-friendly sizes: 32000 | "32k" | "1.5k" | "2m" (1000-based; chars). */
function readSize(rec: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = rec[key]
  if (v === undefined) return undefined
  let n: number | undefined
  if (typeof v === "number" && Number.isFinite(v)) n = Math.floor(v)
  else if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(v.trim())
    if (m) n = Math.floor(Number.parseFloat(m[1]!) * (m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1))
  }
  if (n === undefined) {
    throw new Error(`[advisor] option "${key}" must be a number or size like "64k"/"1.5m", got ${JSON.stringify(v)}`)
  }
  if (n < min || n > max) throw new Error(`[advisor] option "${key}" must be between ${min} and ${max}, got ${v}`)
  return n
}

function readModelRef(v: unknown, label: string): AdvisorModelRef {
  const rec = asRecord(v)
  const providerID = readString(rec, "providerID")
  const id = readString(rec, "id")
  if (!providerID || !id) {
    throw new Error(
      `[advisor] option "${label}" must be { providerID, id, variant? } — ` +
        `got ${JSON.stringify(v)}. Example: { "providerID": "bailian-token-plan", "id": "deepseek-v4-pro" }.`,
    )
  }
  return { providerID, id, variant: readString(rec, "variant") }
}

function readSource(v: unknown): AdvisorSource | undefined {
  if (v === undefined) return undefined
  const rec = asRecord(v)
  const kind = readString(rec, "kind")
  const baseURL = readString(rec, "baseURL")
  const apiKeyEnv = readString(rec, "apiKeyEnv")
  const model = readString(rec, "model")
  if (kind !== "anthropic" && kind !== "openai-compatible") {
    throw new Error(`[advisor] option "source.kind" must be "anthropic" | "openai-compatible", got ${JSON.stringify(kind)}`)
  }
  if (!baseURL || !apiKeyEnv || !model) {
    throw new Error(`[advisor] option "source" requires baseURL, apiKeyEnv and model`)
  }
  const headers = asRecord(rec.extraHeaders)
  const extraHeaders: Record<string, string> = {}
  for (const [k, val] of Object.entries(headers)) if (typeof val === "string") extraHeaders[k] = val
  return { kind, baseURL, apiKeyEnv, model, extraHeaders }
}

function readLogLevel(v: unknown): LogLevel | undefined {
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : undefined
}

/** Config-level mode ids. "agent" is the Review + Agent mechanism; the
 *  explicit "review-agent" alias keeps the JSON self-documenting. */
export function normalizeAdvisorMode(value: string): "review" | "agent" | undefined {
  if (value === "review") return "review"
  if (value === "agent" || value === "review-agent" || value === "review+agent") return "agent"
  return undefined
}

/** Resolve the full option set. Throws with a precise message on invalid input. */
export function resolveOptions(raw: unknown): AdvisorOptions {
  if (Array.isArray(raw)) {
    throw new Error("[advisor] options must be an object, got an array — check your plugins entry shape")
  }
  const opts = asRecord(raw)

  // 1. defaults
  let advisor = DEFAULTS.advisor
  let maxUsesPerTask = DEFAULTS.maxUsesPerTask
  let adviceTokenBudget = DEFAULTS.adviceTokenBudget
  let advisorResponseWaitMs = DEFAULTS.advisorResponseWaitMs
  let maxConsultMs = DEFAULTS.maxConsultMs
  let maxToolOutputChars = DEFAULTS.maxToolOutputChars
  let transcriptBudgetTokens = DEFAULTS.transcriptBudgetTokens
  let advisorMode: AdvisorOptions["advisorMode"] = DEFAULTS.advisorMode
  let logLevel: LogLevel = DEFAULTS.logLevel
  let source: AdvisorSource | undefined

  // 2. environment overrides
  if (ENV.ADVISOR_PROVIDER && ENV.ADVISOR_MODEL) {
    advisor = { providerID: ENV.ADVISOR_PROVIDER, id: ENV.ADVISOR_MODEL, variant: ENV.ADVISOR_VARIANT }
  }
  if (ENV.ADVISOR_MAX_USES) {
    const n = Number.parseInt(ENV.ADVISOR_MAX_USES, 10)
    if (!Number.isFinite(n) || n < 1 || n > 50) throw new Error(`[advisor] ADVISOR_MAX_USES must be 1..50, got "${ENV.ADVISOR_MAX_USES}"`)
    maxUsesPerTask = n
  }
  if (ENV.ADVISOR_LOG) {
    const lv = readLogLevel(ENV.ADVISOR_LOG)
    if (!lv) throw new Error(`[advisor] ADVISOR_LOG must be debug|info|warn|error, got "${ENV.ADVISOR_LOG}"`)
    logLevel = lv
  }
  if (ENV.ADVISOR_MODE) {
    const mode = normalizeAdvisorMode(ENV.ADVISOR_MODE)
    if (!mode) throw new Error(`[advisor] ADVISOR_MODE must be review|agent|review-agent, got "${ENV.ADVISOR_MODE}"`)
    advisorMode = mode
  }
  if (ENV.ADVISOR_SOURCE_KIND) {
    source = readSource({
      kind: ENV.ADVISOR_SOURCE_KIND,
      baseURL: ENV.ADVISOR_SOURCE_URL,
      apiKeyEnv: ENV.ADVISOR_SOURCE_KEY_ENV,
      model: ENV.ADVISOR_SOURCE_MODEL ?? ENV.ADVISOR_MODEL,
    })
  }

  // 3. explicit plugin options win
  const optAdvisor = opts.advisor
  if (optAdvisor !== undefined) advisor = readModelRef(optAdvisor, "advisor")
  const optSource = readSource(opts.source)
  if (optSource !== undefined) source = optSource

  // Preset first (non-technical), then explicit options override it.
  const presetName = readString(opts, "preset")
  if (presetName !== undefined) {
    const preset = PRESETS[presetName]
    if (!preset) {
      throw new Error(`[advisor] option "preset" must be one of: ${Object.keys(PRESETS).join(", ")} — got "${presetName}"`)
    }
    if (preset.maxUsesPerTask !== undefined) maxUsesPerTask = preset.maxUsesPerTask as number
    if (preset.transcriptBudgetTokens !== undefined) {
      transcriptBudgetTokens = readSize({ v: preset.transcriptBudgetTokens as string }, "v", 2_000, 1_000_000) ?? transcriptBudgetTokens
    }
    if (preset.adviceTokenBudget !== undefined) adviceTokenBudget = preset.adviceTokenBudget as number
  }

  maxUsesPerTask = readInt(opts, "maxUsesPerTask", 1, 50) ?? maxUsesPerTask
  let maxAttempts = readInt(opts, "maxAttempts", 1, 100) ?? 0 // 0 = derive from cap
  adviceTokenBudget = readInt(opts, "adviceTokenBudget", 500, 64_000) ?? adviceTokenBudget
  const waitExplicit = readInt(opts, "advisorResponseWaitMs", 100, 600_000)
  const waitLegacy = readInt(opts, "timeoutMs", 1_000, 600_000)
  advisorResponseWaitMs = waitExplicit ?? waitLegacy ?? advisorResponseWaitMs
  if (waitExplicit === undefined && waitLegacy !== undefined) {
    console.warn("[advisor] timeoutMs is deprecated — rename it to advisorResponseWaitMs")
  }
  maxConsultMs = readSize(opts, "maxConsultMs", 1_000, 86_400_000) ?? maxConsultMs
  if (maxConsultMs < advisorResponseWaitMs) {
    console.warn(
      `[advisor] maxConsultMs (${maxConsultMs}) raised to advisorResponseWaitMs (${advisorResponseWaitMs}) — the ceiling must cover the wait window`,
    )
    maxConsultMs = advisorResponseWaitMs
  }
  maxToolOutputChars = readSize(opts, "maxToolOutputChars", 100, 200_000) ?? maxToolOutputChars
  transcriptBudgetTokens = readSize(opts, "transcriptBudgetTokens", 2_000, 1_000_000) ?? transcriptBudgetTokens
  let triggers: string[] = [...DEFAULT_TRIGGERS]
  if (opts.triggers !== undefined) {
    if (!Array.isArray(opts.triggers)) {
      throw new Error(`[advisor] option "triggers" must be an array of strings, got ${typeof opts.triggers}`)
    }
    triggers = []
    for (const t of opts.triggers) {
      if (typeof t !== "string" || t.trim() === "") {
        throw new Error(`[advisor] option "triggers" must contain only non-empty strings, got ${JSON.stringify(t)}`)
      }
      triggers.push(t)
    }
  }
  const optLevel = readLogLevel(opts.logLevel)
  if (optLevel !== undefined) logLevel = optLevel
  const optMode = readString(opts, "advisorMode")
  if (optMode !== undefined) {
    const mode = normalizeAdvisorMode(optMode)
    if (!mode) throw new Error(`[advisor] option "advisorMode" must be review|agent|review-agent, got "${optMode}"`)
    advisorMode = mode
  }

  if (!advisor.providerID || !advisor.id) {
    // NOT an error: the plugin loads in an unconfigured state. The advisor
    // tool stays registered and returns a setup-carrying not_configured
    // error; /advisor-settings (or the opencode.json option) configures it.
    // This keeps a fresh install safe (zero advisor spend) and friendly
    // (the tool itself teaches the setup steps at the moment of need).
    advisor = { providerID: "", id: "" }
  }

  // sanity: the context budget must accommodate several tool slices
  if (transcriptBudgetTokens < maxToolOutputChars) {
    console.warn(
      `[advisor] transcriptBudgetTokens (${transcriptBudgetTokens}) raised to maxToolOutputChars ` +
        `(${maxToolOutputChars}) — a smaller budget cannot hold a meaningful excerpt`,
    )
    transcriptBudgetTokens = maxToolOutputChars
  }

  return {
    advisor,
    source,
    maxUsesPerTask,
    maxAttempts: maxAttempts > 0 ? maxAttempts : maxUsesPerTask * 3 + 2,
    adviceTokenBudget,
    transcriptBudgetTokens,
    advisorResponseWaitMs,
    maxConsultMs,
    prune: { maxToolOutputChars, transcriptBudgetChars: transcriptBudgetTokens * 4 },
    advisorMode,
    triggers,
    logLevel,
  }
}

/**
 * Note: there is deliberately NO nudge/tier heuristic here anymore. The
 * advisor is manual-only: no explicit user request ⇒ no injection, no spend.
 */
