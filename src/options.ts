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

/** Non-technical presets: a single word tunes the whole cost/quality curve. */
export const PRESETS: Record<string, Partial<Record<string, unknown>>> = {
  economy: { maxUsesPerTask: 1, transcriptBudgetChars: "16k", adviceWordBudget: 80 },
  balanced: { maxUsesPerTask: 3, transcriptBudgetChars: "32k", adviceWordBudget: 120 },
  thorough: { maxUsesPerTask: 5, transcriptBudgetChars: "128k", adviceWordBudget: 200 },
  exhaustive: { maxUsesPerTask: 8, transcriptBudgetChars: "500k", adviceWordBudget: 300 },
}

export const DEFAULTS = {
  advisor: { providerID: "", id: "" } as AdvisorModelRef,
  maxUsesPerTask: 3,
  adviceWordBudget: 120,
  timeoutMs: 90_000,
  maxToolOutputChars: 1_500,
  // 32k chars ≈ 8k tokens: balanced default — the recency-weighted excerpt
  // plus original-task pinning preserves signal at roughly ⅔ the cost of 48k
  // (efficiency review F-ledger; tune per workload).
  transcriptBudgetChars: 32_000,
  nudge: "off" as const,
  advisorMode: "review" as const,
  injectTimingPrompt: true,
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

/** Resolve the full option set. Throws with a precise message on invalid input. */
export function resolveOptions(raw: unknown): AdvisorOptions {
  if (Array.isArray(raw)) {
    throw new Error("[advisor] options must be an object, got an array — check your plugins entry shape")
  }
  const opts = asRecord(raw)

  // 1. defaults
  let advisor = DEFAULTS.advisor
  let maxUsesPerTask = DEFAULTS.maxUsesPerTask
  let adviceWordBudget = DEFAULTS.adviceWordBudget
  let timeoutMs = DEFAULTS.timeoutMs
  let maxToolOutputChars = DEFAULTS.maxToolOutputChars
  let transcriptBudgetChars = DEFAULTS.transcriptBudgetChars
  let nudge: AdvisorOptions["nudge"] = DEFAULTS.nudge
  let advisorMode: AdvisorOptions["advisorMode"] = DEFAULTS.advisorMode
  let injectTimingPrompt = DEFAULTS.injectTimingPrompt
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
    if (ENV.ADVISOR_MODE !== "review" && ENV.ADVISOR_MODE !== "agent") {
      throw new Error(`[advisor] ADVISOR_MODE must be review|agent, got "${ENV.ADVISOR_MODE}"`)
    }
    advisorMode = ENV.ADVISOR_MODE
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
    if (preset.transcriptBudgetChars !== undefined) {
      transcriptBudgetChars = readSize({ v: preset.transcriptBudgetChars as string }, "v", 2_000, 2_000_000) ?? transcriptBudgetChars
    }
    if (preset.adviceWordBudget !== undefined) adviceWordBudget = preset.adviceWordBudget as number
  }

  maxUsesPerTask = readInt(opts, "maxUsesPerTask", 1, 50) ?? maxUsesPerTask
  let maxAttempts = readInt(opts, "maxAttempts", 1, 100) ?? 0 // 0 = derive from cap
  adviceWordBudget = readInt(opts, "adviceWordBudget", 20, 1000) ?? adviceWordBudget
  timeoutMs = readInt(opts, "timeoutMs", 1_000, 600_000) ?? timeoutMs
  maxToolOutputChars = readSize(opts, "maxToolOutputChars", 100, 200_000) ?? maxToolOutputChars
  transcriptBudgetChars = readSize(opts, "transcriptBudgetChars", 2_000, 2_000_000) ?? transcriptBudgetChars
  const optNudge = readString(opts, "nudge")
  if (optNudge !== undefined) {
    if (optNudge !== "auto" && optNudge !== "on" && optNudge !== "off") {
      throw new Error(`[advisor] option "nudge" must be auto|on|off, got "${optNudge}"`)
    }
    nudge = optNudge
  }
  if (typeof opts.injectTimingPrompt === "boolean") injectTimingPrompt = opts.injectTimingPrompt
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
    if (optMode !== "review" && optMode !== "agent") {
      throw new Error(`[advisor] option "advisorMode" must be review|agent, got "${optMode}"`)
    }
    advisorMode = optMode
  }

  if (!advisor.providerID || !advisor.id) {
    // NOT an error: the plugin loads in an unconfigured state. The advisor
    // tool stays registered and returns a setup-carrying not_configured
    // error; /advisor-settings (or the opencode.json option) configures it.
    // This keeps a fresh install safe (zero advisor spend) and friendly
    // (the tool itself teaches the setup steps at the moment of need).
    advisor = { providerID: "", id: "" }
  }

  // sanity: transcript budget must accommodate several slices
  if (transcriptBudgetChars < maxToolOutputChars * 4) {
    console.warn(
      `[advisor] transcriptBudgetChars (${transcriptBudgetChars}) raised to maxToolOutputChars*4 ` +
        `(${maxToolOutputChars * 4}) — a smaller budget cannot hold a meaningful excerpt`,
    )
    transcriptBudgetChars = maxToolOutputChars * 4
  }

  return {
    advisor,
    source,
    maxUsesPerTask,
    maxAttempts: maxAttempts > 0 ? maxAttempts : maxUsesPerTask * 3 + 2,
    adviceWordBudget,
    timeoutMs,
    prune: { maxToolOutputChars, transcriptBudgetChars },
    nudge,
    advisorMode,
    injectTimingPrompt,
    triggers,
    logLevel,
  }
}

/**
 * Heuristic: executors in the "small/fast" tier benefit from a nudge
 * (Anthropic: +7pp on Haiku-class, neutral on mid-tier, NEGATIVE on
 * frontier-tier). Explicit small-tier markers win over frontier markers
 * (e.g. glm-5.3-flash is small despite the glm-5 prefix); unknown models
 * default to no nudge (conservative — the timing prompt still guides).
 */
const FRONTIER =
  /(opus|fable|mythos|ultra|(^|[^a-z0-9])pro([^a-z0-9]|$)|-max([^a-z0-9]|$)|(^|[^a-z0-9])o\d+([^a-z0-9]|$)|gpt-[56]|grok|glm-5(\.\d+)?([^a-z0-9]|$)|deepseek-v4-pro|qwen\d\S*-max|claude-(sonnet|opus|haiku)-[45])/i
const SMALL = /(haiku|flash|nano|lite|turbo|small|instant|swift|(^|[^a-z0-9])mini([^a-z0-9]|$)|air\b|3\.3|8b|9b|14b)/i

export function shouldNudgeExecutor(modelId: string | undefined, mode: AdvisorOptions["nudge"]): boolean {
  if (mode === "off") return false
  if (mode === "on") return true
  if (!modelId) return false
  const id = modelId.toLowerCase()
  if (SMALL.test(id)) return true
  if (FRONTIER.test(id)) return false
  return false
}
