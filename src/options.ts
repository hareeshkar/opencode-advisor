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

/**
 * Where the measurements say a second opinion is still worth having.
 *
 * Not a hard limit — the validators accept far more — but the point past which
 * the plugin says "you are asking for less accuracy", because that is what
 * the code-review long-context benchmarks actually measure. Context peaks
 * 32K-64K for bug fixing and 64K-128K for comprehension; output stops paying
 * for itself well before the provider's 64K-128K ceiling.
 */
export const EVIDENCE_CEILING_TOKENS = 128_000
export const EVIDENCE_CEILING_ADVICE_TOKENS = 32_000

/** The one chars↔tokens conversion constant in the plugin. 4 is the
 *  industry-standard approximation for English + code (GPT/Claude/Gemini all
 *  land within ±10%). Every token budget is multiplied by this to reach the
 *  pruner's exact char arithmetic, and by this to reach the response cap. */
export const CHARS_PER_TOKEN = 4

/** Deprecation notices already emitted in this process. Options resolve on
 *  every dispatch (config is hot-reloaded by design), so an undamped warning
 *  repeats per consult and trains readers to ignore it. Once is enough. */
const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}


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
/**
 * The curve is NOT monotonic in context size, and the evidence is unusually
 * consistent for this plugin's exact job (reviewing code and bugs):
 *
 * - LongCodeBench, bug fixing: Claude 3.5 Sonnet solves 29% of issues at 32K
 *   and 3% at 256K. Gemini 2 Flash and GPT-4o also peak at 32K.
 * - LongCodeBench, comprehension: accuracy peaks at 64K-128K for nearly every
 *   model, then falls; one model peaks at 512K and drops to 40% at 1M.
 * - "The Limits of Long-Context Reasoning in Automated Bug Fixing": successful
 *   agentic trajectories stay UNDER 20-30K tokens, and longer contexts
 *   correlate with LOWER resolve rates. Single-shot at 64K with perfect file
 *   inclusion, GPT-5-nano solved zero.
 * - "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval"
 *   (EMNLP 2025): accuracy falls 13.9%-85% as input grows, even with all
 *   distractors MASKED and the evidence immediately before the question. The
 *   authors' own mitigation is to turn a long-context task into a short one.
 * - "Same Task, More Tokens": degradation already appears at 3,000 tokens of
 *   pure padding (0.92 -> 0.68).
 *
 * So the generous setting is a MODERATE one. Every preset below sits inside
 * the measured region where models still reason well; the ceilings exist for
 * users who knowingly want to trade accuracy for reach, not as a "more is
 * better" ladder.
 */
export const PRESETS: Record<string, Partial<Record<string, unknown>>> = {
  economy: { maxUsesPerTask: 1, transcriptBudgetTokens: "16k", adviceTokenBudget: 4_000 },
  balanced: { maxUsesPerTask: 3, transcriptBudgetTokens: "32k", adviceTokenBudget: 8_000 },
  thorough: { maxUsesPerTask: 5, transcriptBudgetTokens: "64k", adviceTokenBudget: 16_000 },
  exhaustive: { maxUsesPerTask: 8, transcriptBudgetTokens: "128k", adviceTokenBudget: 32_000 },
}

export const DEFAULTS = {
  advisor: { providerID: "", id: "" } as AdvisorModelRef,
  maxUsesPerTask: 3,
  // Output length has a NON-MONOTONIC effect on accuracy: "Demystify
  // Reasoning Length" finds correct answers turn incorrect at the longest
  // ranks (~5-10% of them), i.e. overthinking past the point of diminishing
  // returns. A large budget does not make the advisor think harder, it lets it
  // keep going. 8K is past the useful range for a review and well short of
  // where compounding errors start.
  adviceTokenBudget: 8_000,
  advisorResponseWaitMs: 90_000,
  maxConsultMs: 3_600_000,
  // 750 tokens ≈ 3,000 chars: a whole file section or a full stack trace.
  maxToolOutputTokens: 750,
  // 32K tokens ≈ 128K chars — the measured peak for bug-fixing review
  // (LongCodeBench) and a clean room above the sub-20-30K span that
  // successful agentic trajectories actually occupy. It also fits inside a
  // 200K-window model, so the default is portable across the whole 200K-to-1M
  // class rather than assuming the largest window available.
  transcriptBudgetTokens: 32_000,
  pruning: "standard" as const,
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
  if (!providerID && !id) {
    // An all-empty ref is the plugin's own UNCONFIGURED state — `resolveOptions`
    // produces exactly `{ providerID: "", id: "" }` for a fresh install, and
    // "Inherit" on the model in the settings menu produces it too. Treating that
    // as malformed made the save preview throw, so a config could be written
    // that the preview could not describe.
    return { providerID: "", id: "", variant: readString(rec, "variant") }
  }
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
  let maxToolOutputTokens = DEFAULTS.maxToolOutputTokens
  let maxToolOutputChars = maxToolOutputTokens * CHARS_PER_TOKEN
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
    if (!Number.isFinite(n) || n < 1 || n > 1_000) throw new Error(`[advisor] ADVISOR_MAX_USES must be 1..1000, got "${ENV.ADVISOR_MAX_USES}"`)
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
      transcriptBudgetTokens = readSize({ v: preset.transcriptBudgetTokens as string }, "v", 1_000, 1_000_000) ?? transcriptBudgetTokens
    }
    if (preset.adviceTokenBudget !== undefined) adviceTokenBudget = preset.adviceTokenBudget as number
  }

  maxUsesPerTask = readInt(opts, "maxUsesPerTask", 1, 200) ?? maxUsesPerTask
  let maxAttempts = readInt(opts, "maxAttempts", 1, 2_000) ?? 0 // 0 = derive from cap
  // 200K output is comfortably above every real max-output limit in the
  // 1M-window class (Gemini 3.1 Pro / Claude Sonnet 64K, GPT-5.x / Claude
  // Opus 128K). Asking for more is not "generous", it is a value no provider
  // in this class will honour.
  adviceTokenBudget = readInt(opts, "adviceTokenBudget", 256, 200_000) ?? adviceTokenBudget
  const waitExplicit = readInt(opts, "advisorResponseWaitMs", 1, 3_600_000)
  const waitLegacy = readInt(opts, "timeoutMs", 1, 3_600_000)
  advisorResponseWaitMs = waitExplicit ?? waitLegacy ?? advisorResponseWaitMs
  if (waitExplicit === undefined && waitLegacy !== undefined) {
    warnOnce("timeoutMs", "[advisor] timeoutMs is deprecated — rename it to advisorResponseWaitMs")
  }
  maxConsultMs = readSize(opts, "maxConsultMs", 1_000, 86_400_000) ?? maxConsultMs
  if (maxConsultMs < advisorResponseWaitMs) {
    warnOnce(
      `ceiling<wait:${maxConsultMs}/${advisorResponseWaitMs}`,
        `[advisor] maxConsultMs (${maxConsultMs}) raised to advisorResponseWaitMs (${advisorResponseWaitMs}) — the ceiling must cover the wait window`,
    )
    maxConsultMs = advisorResponseWaitMs
  }
  // Tool-output ceiling: `maxToolOutputTokens` is canonical (tokens are the
  // unit providers bill in). `maxToolOutputChars` is still accepted and
  // divided by 4, so a pre-1.0 config keeps working and reads honestly.
  // One tool output. 500K tokens ≈ a 2M-character file, which already exceeds
  // any single source file worth sending; above that the value is a mistake,
  // not a preference.
  const toolTokExplicit = readSize(opts, "maxToolOutputTokens", 16, 500_000)
  const toolTokLegacy = readSize(opts, "maxToolOutputChars", 64, 2_000_000)
  if (toolTokExplicit === undefined && toolTokLegacy !== undefined) {
    maxToolOutputTokens = Math.max(4, Math.ceil(toolTokLegacy / CHARS_PER_TOKEN))
    warnOnce(
      "maxToolOutputChars",
      `[advisor] maxToolOutputChars is deprecated — use maxToolOutputTokens ` +
        `(${maxToolOutputTokens} tokens ≈ ${maxToolOutputTokens * CHARS_PER_TOKEN} chars)`,
    )
  } else {
    maxToolOutputTokens = toolTokExplicit ?? maxToolOutputTokens
  }
  maxToolOutputChars = maxToolOutputTokens * CHARS_PER_TOKEN
  // 1,000,000 is the hosted-frontier standard and the ceiling this plugin is
  // sized for (Gemini 3.1 Pro, GPT-5.x, Claude Opus/Sonnet 5 all report
  // 1,000,000–1,048,576). The 2M/10M classes are deliberately out of scope:
  // rare, and sizing to them would only invite configs that fail on the models
  // people actually run. A 200K-window model is the common floor, and the
  // Economy/Balanced presets fit inside it.
  transcriptBudgetTokens = readSize(opts, "transcriptBudgetTokens", 1_000, 1_000_000) ?? transcriptBudgetTokens

  // Pruning policy: "standard" (window + truncate) or "none" (verbatim).
  let pruning: "standard" | "none" = DEFAULTS.pruning
  const optPruning = readString(opts, "pruning")
  if (optPruning !== undefined) {
    if (optPruning !== "standard" && optPruning !== "none") {
      throw new Error(`[advisor] option "pruning" must be "standard" | "none", got ${JSON.stringify(optPruning)}`)
    }
    pruning = optPruning
  }
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

  // Above the measured region, a bigger context budget is not more generous —
  // it is measurably worse advice. LongCodeBench puts bug-fixing accuracy at
  // 29% at 32K falling to 3% at 256K, comprehension peaking at 64K-128K, and
  // "Context Length Alone Hurts" shows accuracy falling 13.9-85% purely from
  // input length even with perfect retrieval. Say so, once, with the number
  // the user chose — silently honouring it would be the dishonest option.
  if (transcriptBudgetTokens > EVIDENCE_CEILING_TOKENS) {
    warnOnce(
      `context>evidence:${transcriptBudgetTokens}`,
      `[advisor] transcriptBudgetTokens is ${transcriptBudgetTokens} — past the ~${EVIDENCE_CEILING_TOKENS}-token ` +
        `ceiling where code-review accuracy peaks (measured: 29% bug-fix resolution at 32K, falling to 3% at 256K). ` +
        `A larger budget sends more evidence and measurably WEAKER advice. Use pruning:"none" if you need the rest, ` +
        `or a 1M-window model with a review that genuinely needs the reach.`,
    )
  }
  if (adviceTokenBudget > EVIDENCE_CEILING_ADVICE_TOKENS) {
    warnOnce(
      `advice>evidence:${adviceTokenBudget}`,
      `[advisor] adviceTokenBudget is ${adviceTokenBudget} — past the ~${EVIDENCE_CEILING_ADVICE_TOKENS}-token ` +
        `point where extra output stops adding correctness and starts compounding errors. ` +
        `Output length has a non-monotonic effect on accuracy; a bigger cap permits overthinking, not insight.`,
    )
  }

  // The advisor's context window is a SHARED budget: input (the pruned
  // transcript + system + tools) and output (the reply, plus reasoning tokens
  // on thinking models) all draw on it. Sizing them independently is how a
  // config ends up asking for 1.13M from a 1M window and failing with
  // prompt_too_long. The reference window is the hosted-frontier standard.
  const REFERENCE_WINDOW_TOKENS = 1_000_000
  if (transcriptBudgetTokens + adviceTokenBudget > REFERENCE_WINDOW_TOKENS) {
    warnOnce(
      `window:over:${transcriptBudgetTokens}+${adviceTokenBudget}`,
      `[advisor] context (${transcriptBudgetTokens}) + advice (${adviceTokenBudget}) = ` +
        `${transcriptBudgetTokens + adviceTokenBudget} tokens, past the ${REFERENCE_WINDOW_TOKENS}-token ` +
        `reference window — context and output share one budget, so the advisor will likely fail with ` +
        `prompt_too_long. Lower one of them, or pick a model with a larger window.`,
    )
  }

  // sanity: the context budget must accommodate several tool slices
  if (transcriptBudgetTokens < maxToolOutputChars) {
    warnOnce(
      `budget<toolcap:${transcriptBudgetTokens}/${maxToolOutputChars}`,
      `[advisor] transcriptBudgetTokens (${transcriptBudgetTokens}) raised to maxToolOutputTokens ` +
        `(${maxToolOutputTokens} tokens ≈ ${maxToolOutputChars} chars) — a smaller budget cannot hold a meaningful excerpt`,
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
    maxToolOutputTokens,
    pruning,
    advisorResponseWaitMs,
    maxConsultMs,
    prune: { maxToolOutputChars, transcriptBudgetChars: transcriptBudgetTokens * CHARS_PER_TOKEN, pruning },
    advisorMode,
    triggers,
    logLevel,
  }
}

/**
 * Note: there is deliberately NO nudge/tier heuristic here anymore. The
 * advisor is manual-only: no explicit user request ⇒ no injection, no spend.
 */
