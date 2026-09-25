/**
 * Shared types for opencode-advisor.
 *
 * Zero runtime dependencies by design: everything here is either a plain
 * interface consumed by our own code or a structural description of host
 * (OpenCode V1/V2) objects we consume defensively.
 */

export const PLUGIN_ID = "opencode-advisor"
export const PLUGIN_VERSION = "0.5.0"

export type LogLevel = "debug" | "info" | "warn" | "error"

/** Reference to a model registered in the host's provider catalog. */
export interface AdvisorModelRef {
  providerID: string
  id: string
  variant?: string
}

/**
 * Direct advisor endpoint (V1 adapter / standalone use only).
 * The V2 adapter never needs this — it routes through the host's provider
 * registry via `ctx.generate.text`, reusing the user's configured credentials.
 */
export interface AdvisorSource {
  kind: "anthropic" | "openai-compatible"
  baseURL: string
  apiKeyEnv: string
  model: string
  extraHeaders?: Record<string, string>
}

export interface PruneOptions {
  /** Maximum characters per tool output after truncation. */
  maxToolOutputChars: number
  /** Total character budget for the pruned transcript. */
  transcriptBudgetChars: number
}

export interface AdvisorOptions {
  /** The high-judgment model consulted mid-task. Required. */
  advisor: AdvisorModelRef
  /** Direct endpoint for the V1 adapter (optional in V2). */
  source?: AdvisorSource
  /** Max advisor calls per user task. Default 3 (matches Anthropic evals). */
  maxUsesPerTask: number
  /** Dispatch-attempt ceiling per task (default derived: maxUsesPerTask*3+2). */
  maxAttempts: number
  /** Target advisor response length in words (prompt-enforced + hard cap). */
  adviceWordBudget: number
  /** Sub-call timeout in ms. Default 90_000. */
  timeoutMs: number
  /** Transcript pruning knobs. */
  prune: PruneOptions
  /**
   * Nudge behavior for executors that under-call the advisor:
   * "auto" (small-tier executors only — Anthropic measured +7pp on Haiku,
   * neutral on Sonnet, NEGATIVE on Opus-tier), "on", "off".
   */
  nudge: "auto" | "on" | "off"
  /**
   * Advisor operating mode:
   *  - "review" (default): tool-less single-shot advice over the pruned
   *    transcript — native parity with Anthropic's advisor, cheapest.
   *  - "agent": the advisor runs as a read-only child session (plan agent,
   *    advisor model) that can read/grep/glob and make multiple tool calls
   *    to VERIFY claims before advising — grounded guidance, higher cost.
   */
  advisorMode: "review" | "agent"
  /** Inject the executor timing prompt (once per task, transient). */
  injectTimingPrompt: boolean
  /**
   * Trigger words routing user messages to the advisor flow
   * (case-insensitive substring; empty list disables the flow).
   * Default: ["advice", "advisor", "get consultation"].
   */
  triggers: string[]
  logLevel: LogLevel
}

/** One normalized transcript slice, host-agnostic. */
export interface Slice {
  role: "user" | "assistant" | "tool"
  /** Origin label for tool slices (tool name) or synthetic markers. */
  name?: string
  text: string
}

export interface PruneStats {
  inChars: number
  outChars: number
  droppedSlices: number
  truncatedSlices: number
  elapsedMs: number
}

export type AdvisorErrorCode =
  | "max_uses_exceeded"
  | "too_many_requests"
  | "overloaded"
  | "prompt_too_long"
  | "execution_time_exceeded"
  | "model_not_found"
  | "not_configured"
  | "unavailable"

export interface ConsultStats {
  prune: PruneStats
  promptChars: number
  adviceChars: number
  estTokensIn: number
  estTokensOut: number
  elapsedMs: number
}

export type ConsultResult =
  | { ok: true; advice: string; stats: ConsultStats }
  | { ok: false; errorCode: AdvisorErrorCode; message: string }

export interface UsageEntry {
  date: string // YYYY-MM-DD
  calls: number
  errors: number
  estTokensIn: number
  estTokensOut: number
  adviceChars: number
}

/**
 * Host adapter — the only surface the engine touches. V1 and V2 each provide
 * one implementation; the engine is pure orchestration and fully testable
 * without a running OpenCode.
 */
export interface Host {
  /** Normalized transcript for a session (most recent last). */
  getTranscript(sessionID: string): Promise<readonly Slice[]>
  /**
   * Run the advisor sub-call. Must be tool-less and history-less.
   * Receives the sessionID (provider routing headers), the per-call
   * evidence nonce (native-request correlation), and the CURRENT advisor
   * model ref (hot-swappable via settings).
   */
  runAdvisor(
    prompt: string,
    signal: AbortSignal,
    sessionID: string,
    nonce: string,
    model: AdvisorModelRef,
  ): Promise<string>
  /** Durable usage aggregation (fire-and-forget semantics). */
  persistUsage(entry: UsageEntry): Promise<void>
  log(level: LogLevel, message: string, data?: unknown): void
}

/** Decision returned per model-call step for system injection. */
export interface StepDecision {
  injectTiming: boolean
  injectNudge: boolean
}

export interface TaskState {
  /** Task generation: bumped by resetTask; guards straggler accounting. */
  generation: number
  /** Successful advisor uses this task (the user-facing cap). */
  calls: number
  /** Total dispatch attempts this task (anti-retry-storm ceiling). */
  attempts: number
  /** Dispatched but not yet settled (bounds parallel-round overshoot). */
  inFlight: number
  steps: number
  timingInjected: boolean
  advisorUsed: boolean
  nudged: boolean
  /** First-user-slice prefix; detects task changes the prompt hook missed. */
  taskFingerprint: string | undefined
  /** One-shot host-hook-delivery warning flag. */
  hookWarned: boolean
  lastSeen: number
}
