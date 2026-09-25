/**
 * AdvisorEngine — host-agnostic orchestration core.
 *
 * Owns everything except transport: per-task call caps, step/nudge decisions,
 * pruning, prompt assembly, timeout enforcement, error-code mapping, output
 * caps, and usage accounting. V1/V2 adapters provide the Host implementation.
 */

import { buildAdvisorPrompt } from "./prompts.js"
import { pruneTranscript } from "./pruner.js"
import type { AdvisorErrorCode, ConsultResult, Host, StepDecision, TaskState, UsageEntry } from "./types.js"

/**
 * Physical output cap: enforce the word budget exactly (token length varies
 * wildly across languages and models), with a char-based safety ceiling for
 * pathological single-token runs.
 */
function hardCapWords(text: string, words: number): string {
  const maxChars = words * 12
  let t = text
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars)
    const lastSpace = cut.lastIndexOf(" ")
    t = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()
    t += " …[truncated]"
  }
  const parts = t.split(/\s+/).filter((w) => w !== "")
  if (parts.length > words) {
    t = parts.slice(0, words).join(" ") + " …[truncated]"
  }
  return t
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`advisor sub-call timed out after ${ms}ms`)), ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("advisor sub-call aborted"))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}

const ERROR_MAP: Array<[RegExp, AdvisorErrorCode]> = [
  [/timed? ?out|timeout|etimedout|aborted/i, "execution_time_exceeded"],
  [/429|rate.?limit|too many requests|quota/i, "too_many_requests"],
  [/overloaded|capacity|503|502|504|internal server/i, "overloaded"],
  [/not found|404|unknown model|invalid model|does not exist/i, "model_not_found"],
  [/context (length|window)|too long|413|prompt_too_long/i, "prompt_too_long"],
]

function classifyError(err: unknown): { errorCode: AdvisorErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  for (const [re, code] of ERROR_MAP) if (re.test(message)) return { errorCode: code, message }
  return { errorCode: "unavailable", message }
}

const MAX_TRACKED_SESSIONS = 512

export class AdvisorEngine {
  private tasks = new Map<string, TaskState>()

  constructor(
    private readonly opts: import("./types.js").AdvisorOptions,
    private readonly host: Host,
  ) {}

  private state(sessionID: string): TaskState {
    let st = this.tasks.get(sessionID)
    if (!st) {
      if (this.tasks.size >= MAX_TRACKED_SESSIONS) {
        // evict the least-recently-seen entry
        let oldestKey: string | undefined
        let oldest = Infinity
        for (const [k, v] of this.tasks) if (v.lastSeen < oldest) (oldest = v.lastSeen), (oldestKey = k)
        if (oldestKey) this.tasks.delete(oldestKey)
      }
      st = { calls: 0, steps: 0, advisorUsed: false, nudged: false, lastSeen: Date.now() }
      this.tasks.set(sessionID, st)
    }
    st.lastSeen = Date.now()
    return st
  }

  /** New user prompt admitted → fresh task state. */
  resetTask(sessionID: string): void {
    this.tasks.set(sessionID, { calls: 0, steps: 0, advisorUsed: false, nudged: false, lastSeen: Date.now() })
  }

  markAdvisorUsed(sessionID: string): void {
    this.state(sessionID).advisorUsed = true
  }

  /**
   * Called once per model request (context hook / system transform).
   * Returns the injection decision for this step. Timing fires on the first
   * step of a task only; the nudge fires once at NUDGE_STEP for eligible
   * executors that haven't used the advisor (Anthropic: +7pp Haiku-class,
   * negative on frontier-tier).
   */
  noteStep(sessionID: string, executorModelId: string | undefined, nudgeEligible: boolean): StepDecision {
    const st = this.state(sessionID)
    const step = st.steps++
    const injectTiming = this.opts.injectTimingPrompt && step === 0
    const NUDGE_STEP = 1 // fires on the 2nd model call of a task
    const injectNudge =
      !st.nudged &&
      !st.advisorUsed &&
      step === NUDGE_STEP &&
      nudgeEligible &&
      (this.opts.nudge === "on" || (this.opts.nudge === "auto" && nudgeEligible))
    if (injectNudge) st.nudged = true
    void executorModelId
    return { injectTiming, injectNudge }
  }

  /** The core escalation path, invoked by the `advisor` tool executor. */
  async consult(sessionID: string, signal: AbortSignal): Promise<ConsultResult> {
    const st = this.state(sessionID)
    st.calls++
    if (st.calls > this.opts.maxUsesPerTask) {
      return {
        ok: false,
        errorCode: "max_uses_exceeded",
        message: `Advisor cap of ${this.opts.maxUsesPerTask} calls reached for this task. Continue without further advice.`,
      }
    }

    const started = Date.now()
    let transcript: readonly import("./types.js").Slice[]
    try {
      transcript = await this.host.getTranscript(sessionID)
    } catch (err) {
      const { errorCode, message } = classifyError(err)
      return { ok: false, errorCode, message: `transcript read failed: ${message}` }
    }

    const pruned = pruneTranscript(transcript, this.opts.prune)
    if (pruned.text.trim() === "") {
      return { ok: false, errorCode: "unavailable", message: "Transcript is empty after pruning — nothing to advise on." }
    }

    const prompt = buildAdvisorPrompt(pruned.text, this.opts)
    const promptChars = prompt.length

    let raw: string
    try {
      raw = await withTimeout(this.host.runAdvisor(prompt, signal), this.opts.timeoutMs, signal)
    } catch (err) {
      this.recordUsage(false, 0, 0, Date.now() - started).catch(() => {})
      const { errorCode, message } = classifyError(err)
      return { ok: false, errorCode, message }
    }

    const advice = hardCapWords(raw.trim(), this.opts.adviceWordBudget)
    if (advice === "") {
      this.recordUsage(false, promptChars, 0, Date.now() - started).catch(() => {})
      return { ok: false, errorCode: "unavailable", message: "Advisor returned an empty response." }
    }

    const stats = {
      prune: pruned.stats,
      promptChars,
      adviceChars: advice.length,
      estTokensIn: Math.ceil(promptChars / 4),
      estTokensOut: Math.ceil(advice.length / 4),
      elapsedMs: Date.now() - started,
    }
    st.advisorUsed = true
    this.recordUsage(true, stats.estTokensIn, stats.estTokensOut, stats.elapsedMs, advice.length).catch(() => {})
    this.host.log(
      "info",
      `consult ok: ${stats.estTokensIn}t in / ${stats.estTokensOut}t out / ${stats.elapsedMs}ms ` +
        `(prune ${(pruned.stats.outChars / Math.max(1, pruned.stats.inChars)).toFixed(2)}, calls ${st.calls}/${this.opts.maxUsesPerTask})`,
    )
    return { ok: true, advice, stats }
  }

  /** Fire-and-forget usage aggregation (never blocks the escalation path). */
  private async recordUsage(ok: boolean, tokensIn: number, tokensOut: number, elapsedMs: number, adviceChars = 0): Promise<void> {
    const date = new Date().toISOString().slice(0, 10)
    const entry: UsageEntry = {
      date,
      calls: ok ? 1 : 0,
      errors: ok ? 0 : 1,
      estTokensIn: tokensIn,
      estTokensOut: tokensOut,
      adviceChars,
    }
    void elapsedMs
    try {
      await this.host.persistUsage(entry)
    } catch {
      // usage persistence is best-effort by contract
    }
  }
}
