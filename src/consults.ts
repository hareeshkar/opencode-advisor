/**
 * ConsultRunner ledger — async consult lifecycle (v0.8.0).
 *
 * Separates the three clocks that the old single `timeoutMs` conflated:
 *   1. Launch detection  — provider response errors surface immediately as
 *      `advisor_not_running` (never awaited through any window).
 *   2. `advisorResponseWaitMs` — how long the executor's tool call blocks for
 *      a normal successful answer (UX). Expiry returns RUNNING; the consult
 *      keeps running. This is NOT a state transition and NOT a kill switch.
 *   3. `maxConsultMs` — the consultation's lifetime ceiling. Expiry marks it
 *      `failed — advisor_not_running` WITHOUT consuming the consult cap.
 *
 * States: STARTING → RUNNING → COMPLETED | FAILED. Delivery is a FIELD on
 * completed consults (`pending` → `injected`), not a state: it is asynchronous
 * and can fail independently (the ledger replays advice regardless).
 *
 * Ownership: the OpenCode server process owns running consults — it outlives
 * tool calls. The kv-backed ledger survives plugin reloads; a setup-time
 * reaper fails ledger entries stuck past the ceiling.
 */

export type ConsultState = "starting" | "running" | "completed" | "failed"
export type ConsultDelivery = "pending" | "injected"

export interface ConsultRecord {
  id: string
  sessionID: string
  mode: string
  model: string
  startedAt: number
  state: ConsultState
  delivery: ConsultDelivery
  /** Framed advice — present once completed. */
  advice?: string
  /** Failure reason — present once failed. */
  error?: string
  elapsedMs?: number
}

export interface ConsultClock {
  now(): number
}

const MAX_RECORDS = 100

export const CONSULT_CONCURRENCY = 2

/** The user-facing promise made when the sync wait expires. */
export function runningMessage(id: string, elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000))
  return [
    "ADVISOR CONSULT RUNNING",
    `id: ${id}`,
    `elapsed: ${seconds}s`,
    "",
    "The advisor is still running.",
    "You do not need to start another consultation.",
    "Its advice will be delivered automatically when ready.",
    "",
    "Use advisor_status to check progress.",
  ].join("\n")
}

export class ConsultLedger {
  private entries = new Map<string, ConsultRecord>()

  constructor(private readonly clock: ConsultClock = { now: () => Date.now() }) {}

  now(): number {
    return this.clock.now()
  }

  start(rec: Omit<ConsultRecord, "state" | "delivery" | "startedAt" | "elapsedMs"> & { startedAt?: number }): ConsultRecord {
    const record: ConsultRecord = {
      state: "running",
      delivery: "pending",
      startedAt: this.clock.now(),
      ...rec,
    }
    this.entries.set(rec.id, record)
    this.trim()
    return record
  }

  /** Idempotent: a completed/failed consult never changes state again. */
  complete(id: string, advice: string): void {
    const r = this.entries.get(id)
    if (!r || r.state === "completed" || r.state === "failed") return
    r.state = "completed"
    r.advice = advice
    r.elapsedMs = this.clock.now() - r.startedAt
  }

  markInjected(id: string): void {
    const r = this.entries.get(id)
    if (r && r.state === "completed") r.delivery = "injected"
  }

  /** Idempotent — a reload mid-consult must not double-fail an entry. */
  fail(id: string, error: string): void {
    const r = this.entries.get(id)
    if (!r || r.state === "completed" || r.state === "failed") return
    r.state = "failed"
    r.error = error
    r.elapsedMs = this.clock.now() - r.startedAt
  }

  /** This session's consults, newest first. */
  list(sessionID: string): ConsultRecord[] {
    return [...this.entries.values()]
      .filter((r) => r.sessionID === sessionID)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): ConsultRecord | undefined {
    return this.entries.get(id)
  }

  runningCount(): number {
    let n = 0
    for (const r of this.entries.values()) if (r.state === "running" || r.state === "starting") n++
    return n
  }

  /**
   * Setup-time lifecycle sweep: EVERY running/starting entry is stale by
   * definition (this process owns no detached promises from a previous
   * instance). Failing them all unconditionally prevents hot-reload orphans
   * from permanently occupying concurrency slots. Idempotent.
   */
  failAllRunning(reason: string): string[] {
    const reaped: string[] = []
    for (const r of this.entries.values()) {
      if (r.state === "starting" || r.state === "running") {
        this.fail(r.id, reason)
        reaped.push(r.id)
      }
    }
    return reaped
  }

  private trim(): void {
    if (this.entries.size <= MAX_RECORDS) return
    let oldest: ConsultRecord | undefined
    for (const r of this.entries.values()) if (!oldest || r.startedAt < oldest.startedAt) oldest = r
    if (oldest) this.entries.delete(oldest.id)
  }
}
