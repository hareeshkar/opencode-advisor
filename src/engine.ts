/**
 * AdvisorEngine — host-agnostic orchestration core.
 *
 * Owns everything except transport: per-task call caps, step/nudge decisions,
 * pruning, prompt assembly, timeout enforcement, error-code mapping, output
 * caps, and usage accounting. V1/V2 adapters provide the Host implementation.
 *
 * Trust model: transcript content and advisor output are BOTH untrusted I/O.
 * Errors surfaced to the model are redacted (never raw upstream text);
 * advice is sanitized and framed as a peer opinion before re-entering the
 * executor turn.
 */

import { buildAdvisorPrompt, isAdvisorConfigured, notConfiguredMessage } from "./prompts.js"
import { pruneTranscript } from "./pruner.js"
import { redactError, sanitizeAdviceText } from "./sanitize.js"
import type {
  AdvisorErrorCode,
  AdvisorOptions,
  ConsultResult,
  Host,
  Slice,
  StepDecision,
  TaskState,
  UsageEntry,
} from "./types.js"

/**
 * Physical output cap: enforce the word budget exactly (token length varies
 * wildly across languages and models), with a char-based safety ceiling for
 * pathological single-token runs. One word is reserved for the truncation
 * marker so output is never `words + 1`.
 */
function hardCapWords(text: string, words: number): string {
  const MARKER = "…[truncated]"
  let t = text
  const maxChars = words * 12
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars)
    const lastSpace = cut.lastIndexOf(" ")
    t = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()
  }
  const parts = t.split(/\s+/).filter((w) => w !== "")
  if (parts.length > words) {
    t = parts.slice(0, Math.max(1, words - 1)).join(" ") + " " + MARKER
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
  [/not found|404|unknown model|invalid model|does not exist|model unavailable/i, "model_not_found"],
  [/context (length|window)|too long|413|prompt_too_long/i, "prompt_too_long"],
]

function classifyError(err: unknown): { errorCode: AdvisorErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  for (const [re, code] of ERROR_MAP) if (re.test(message)) return { errorCode: code, message }
  return { errorCode: "unavailable", message }
}

/** First user slice prefix — binds state to the actual task, not just the session. */
function taskFingerprint(transcript: readonly Slice[]): string {
  const first = transcript.find((s) => s.role === "user")
  return first ? first.text.slice(0, 120) : ""
}

/**
 * Bound the raw transcript BEFORE normalization cost grows with session size:
 * keep the original task plus the most recent slices under 4× the char
 * budget (and at most MAX_WINDOW_SLICES). Recency is what the pruner wants
 * anyway; this only caps peak memory.
 */
const MAX_WINDOW_SLICES = 400

export function windowTranscript(slices: readonly Slice[], budgetChars: number): Slice[] {
  const cap = budgetChars * 4
  const firstUserIdx = slices.findIndex((s) => s.role === "user")
  let used = 0
  let start = slices.length
  let count = 0
  for (let i = slices.length - 1; i >= 0 && count < MAX_WINDOW_SLICES; i--) {
    const len = slices[i]!.text.length
    if (used + len > cap && count > 0) break
    used += len
    start = i
    count++
  }
  const out = slices.slice(start)
  if (firstUserIdx >= 0 && firstUserIdx < start) return [slices[firstUserIdx]!, ...out]
  return [...out]
}

const MAX_TRACKED_SESSIONS = 512

export class AdvisorEngine {
  private tasks = new Map<string, TaskState>()
  /** Live advisor model — config default, overridable at runtime (settings). */
  private advisorRef: import("./types.js").AdvisorModelRef

  constructor(
    private opts: AdvisorOptions,
    private readonly host: Host,
  ) {
    this.advisorRef = { ...opts.advisor }
  }

  /** The advisor model currently in effect (config default or hot-swapped). */
  advisor(): import("./types.js").AdvisorModelRef {
    return this.advisorRef
  }

  /** Hot-swap the advisor model (used by /advisor-settings). */
  setAdvisor(ref: import("./types.js").AdvisorModelRef): void {
    this.advisorRef = { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
  }

  /**
   * Apply a freshly resolved option set (settings save / config file reload).
   * Takes effect immediately — no restart. Callers own model hot-swap via
   * setAdvisor; this only replaces limits, budgets, mode, and triggers.
   */
  applyOptions(next: AdvisorOptions): void {
    this.opts = next
  }

  private state(sessionID: string): TaskState {
    let st = this.tasks.get(sessionID)
    if (!st) {
      this.evictIfNeeded()
      st = {
        calls: 0,
        attempts: 0,
        inFlight: 0,
        generation: 0,
        steps: 0,
        timingInjected: false,
        advisorUsed: false,
        nudged: false,
        taskFingerprint: undefined,
        hookWarned: false,
        lastSeen: Date.now(),
      }
      this.tasks.set(sessionID, st)
    }
    st.lastSeen = Date.now()
    return st
  }

  /** Bound the task map; call before every insertion. */
  private evictIfNeeded(): void {
    if (this.tasks.size < MAX_TRACKED_SESSIONS) return
    let oldestKey: string | undefined
    let oldest = Infinity
    for (const [k, v] of this.tasks) if (v.lastSeen < oldest) (oldest = v.lastSeen), (oldestKey = k)
    if (oldestKey) this.tasks.delete(oldestKey)
  }

  /**
   * New user prompt admitted → fresh task state. Mutates in place so an
   * in-flight consult keeps writing to the live object instead of an orphan.
   */
  resetTask(sessionID: string): void {
    this.evictIfNeeded()
    const st = this.state(sessionID)
    st.generation++
    st.calls = 0
    st.attempts = 0
    st.inFlight = 0
    st.steps = 0
    st.timingInjected = false
    st.advisorUsed = false
    st.nudged = false
    st.taskFingerprint = undefined
    st.hookWarned = false
    st.lastSeen = Date.now()
  }

  markAdvisorUsed(sessionID: string): void {
    this.state(sessionID).advisorUsed = true
  }

  /** Snapshot of task state for diagnostics (drives the diag:health ledger key). */
  health(sessionID: string): {
    calls: number
    attempts: number
    steps: number
    timingInjected: boolean
    advisorUsed: boolean
    nudged: boolean
  } {
    const st = this.tasks.get(sessionID)
    if (!st) {
      return { calls: 0, attempts: 0, steps: 0, timingInjected: false, advisorUsed: false, nudged: false }
    }
    return {
      calls: st.calls,
      attempts: st.attempts,
      steps: st.steps,
      timingInjected: st.timingInjected,
      advisorUsed: st.advisorUsed,
      nudged: st.nudged,
    }
  }

  /**
   * Called once per model request (context hook / system transform).
   *
   * Injection is STATE-DRIVEN, not index-driven: the timing prompt fires on
   * the first *injectable* call of a task (whatever its index), and flags
   * latch only when the caller confirms the system array was actually
   * writable — so a non-array `event.system` or a failed prompt-hook
   * registration degrades gracefully instead of silently suppressing
   * guidance. The nudge window opens at the 2nd call and stays open, so
   * hidden/auxiliary model calls can't steal the slot.
   *
   * `nudgeEligible` may be a lazy callback so executor-tier matching runs
   * only when a nudge is actually on the table.
   */
  noteStep(
    sessionID: string,
    nudgeEligible: boolean | (() => boolean),
    canInject = true,
  ): StepDecision {
    const st = this.state(sessionID)
    st.steps++
    const injectTiming = this.opts.injectTimingPrompt && !st.timingInjected && canInject
    if (injectTiming) st.timingInjected = true
    const nudgePossible = !st.nudged && !st.advisorUsed && st.steps >= 2
    const eligible = nudgePossible ? (typeof nudgeEligible === "function" ? nudgeEligible() : nudgeEligible) : false
    const injectNudge = nudgePossible && eligible && canInject && this.opts.nudge !== "off"
    if (injectNudge) st.nudged = true
    return { injectTiming, injectNudge }
  }

  /** The core escalation path, invoked by the `advisor` tool executor. */
  async consult(sessionID: string, signal: AbortSignal): Promise<ConsultResult> {
    // Unconfigured installs answer with setup steps instead of advice —
    // before any bookkeeping, so it never consumes caps or attempts.
    if (!isAdvisorConfigured(this.advisorRef)) {
      return { ok: false, errorCode: "not_configured", message: notConfiguredMessage() }
    }
    const st = this.state(sessionID)
    const started = Date.now()
    const fail = (
      errorCode: AdvisorErrorCode,
      message: string,
      tokensIn = 0,
    ): ConsultResult => {
      this.recordUsage(false, tokensIn, 0, Date.now() - started).catch(() => {})
      return { ok: false, errorCode, message: redactError(message) }
    }

    // Fetch FIRST: the transcript identifies the task, so a stale cap from a
    // missed prompt hook must never block the very consult that would heal
    // it. A session.context read is local and token-free.
    let transcript: readonly Slice[]
    try {
      transcript = await this.host.getTranscript(sessionID)
    } catch (err) {
      const { errorCode, message } = classifyError(err)
      return fail(errorCode, `transcript read failed: ${message}`)
    }

    // Self-healing: task changed without a prompt-hook reset → start fresh.
    const fp = taskFingerprint(transcript)
    if (st.taskFingerprint === undefined) {
      st.taskFingerprint = fp
    } else if (fp !== st.taskFingerprint) {
      this.resetTask(sessionID)
      this.state(sessionID).taskFingerprint = fp
    }

    // Successful-use cap (failures never consume it) plus an in-flight
    // reservation so parallel tool rounds can't overshoot the cap before
    // the first completion lands.
    if (st.calls + st.inFlight >= this.opts.maxUsesPerTask) {
      return {
        ok: false,
        errorCode: "max_uses_exceeded",
        message: `Advisor already consulted ${st.calls}/${this.opts.maxUsesPerTask} successful times this task. Continue without further advice.`,
      }
    }

    // Attempt ceiling: bounds retry storms against a throttled provider
    // without punishing the user for transient failures (configurable).
    const attemptCeiling = this.opts.maxAttempts || this.opts.maxUsesPerTask * 3 + 2
    if (st.attempts >= attemptCeiling) {
      return {
        ok: false,
        errorCode: "max_uses_exceeded",
        message: `Advisor attempt ceiling (${attemptCeiling}) reached this task. Continue without further advice.`,
      }
    }
    // Generation-guarded accounting (grounded-review finding): resetTask may
    // fire mid-consult (steering / new prompt / fingerprint self-heal) and
    // zeroes the counters in place. Every mutation below applies ONLY if the
    // task generation is unchanged when it happens — a straggler from a
    // previous task must never consume the new task's quota or flip its
    // latches.
    const gen = st.generation
    st.attempts++
    st.inFlight++
    try {
      return await this.dispatch(st, transcript, sessionID, signal, fail, started, gen)
    } finally {
      if (st.generation === gen) st.inFlight--
    }
  }

  private async dispatch(
    st: TaskState,
    transcript: readonly Slice[],
    sessionID: string,
    signal: AbortSignal,
    fail: (errorCode: AdvisorErrorCode, message: string, tokensIn?: number) => ConsultResult,
    started: number,
    gen: number,
  ): Promise<ConsultResult> {
    const pruned = pruneTranscript(windowTranscript(transcript, this.opts.prune.transcriptBudgetChars), this.opts.prune)
    if (pruned.text.trim() === "") {
      return fail("unavailable", "Transcript is empty after pruning — nothing to advise on.")
    }

    // Per-call evidence nonce: closes the prompt's evidence region AND lets
    // the native-request hook correlate this sub-call with its session.
    const nonce = Math.random().toString(36).slice(2, 12)
    const prompt = buildAdvisorPrompt(pruned.text, pruned.stats, this.opts, nonce)
    const promptChars = prompt.length
    const estTokensIn = Math.ceil(promptChars / 4)

    // Turn-1 assertion: if model calls keep arriving but no injection was
    // ever delivered, the host is swallowing context hooks — say so once,
    // loudly, instead of running a silently unguided task.
    if (!st.timingInjected && st.steps > 3 && !st.hookWarned) {
      st.hookWarned = true
      this.host.log(
        "warn",
        "advisor: no system injection delivered after 3+ model calls — host may not be delivering " +
          "context hooks (timing/nudge guidance inactive). See opencode-advisor troubleshooting.",
      )
    }

    let raw: string
    try {
      raw = await withTimeout(this.host.runAdvisor(prompt, signal, sessionID, nonce, this.advisorRef), this.opts.timeoutMs, signal)
    } catch (err) {
      const { errorCode, message } = classifyError(err)
      return fail(errorCode, message, estTokensIn)
    }

    const advice = sanitizeAdviceText(hardCapWords(raw.trim(), this.opts.adviceWordBudget))
    if (advice === "") {
      return fail("unavailable", "Advisor returned an empty response.", estTokensIn)
    }

    const stats = {
      prune: pruned.stats,
      promptChars,
      adviceChars: advice.length,
      estTokensIn,
      estTokensOut: Math.ceil(advice.length / 4),
      elapsedMs: Date.now() - started,
    }
    // Generation-guarded: a straggler completing after a task reset must not
    // consume the NEW task's quota or flip its latch (grounded-review finding).
    if (st.generation === gen) {
      st.calls++
      this.markAdvisorUsed(sessionID)
    }
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
