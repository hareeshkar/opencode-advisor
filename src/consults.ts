/**
 * ConsultRunner ledger — async consult lifecycle (v0.9.x).
 *
 * Separates the clocks the old single timeout conflated:
 *   1. Launch detection — provider errors surface immediately as
 *      `advisor_not_running` (never awaited through any window).
 *   2. `advisorResponseWaitMs` — how long the executor's tool call blocks for
 *      a normal successful answer (UX). Expiry returns RUNNING; the consult
 *      keeps running. NOT a state transition, NOT a kill switch.
 *   3. `maxConsultMs` — the consultation's lifetime ceiling. Expiry marks it
 *      failed (`advisor_not_running`) WITHOUT consuming the consult cap.
 *
 * States: STARTING → RUNNING → COMPLETED | FAILED. Delivery is a FIELD on
 * completed consults (`pending` → `injected` → or `inline` when the advice
 * rode the tool result), not a state: it is asynchronous and can fail
 * independently (the ledger replays advice regardless).
 *
 * Ownership: the OpenCode server process owns running consults — it outlives
 * tool calls. The ledger is IN-MEMORY by design: it never persists prompts,
 * and a fresh instance starts clean (no hot-reload orphans). With an optional
 * persistence sink wired, terminal records survive reloads so advisor_status
 * keeps its history and per-consult spend stays attributable (the global
 * usage ledger is a date aggregate that concurrent sessions pollute).
 */

export type ConsultState = "starting" | "running" | "completed" | "failed"
export type ConsultDelivery = "pending" | "injected" | "inline"

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

/**
 * Optional durable sink/source for the ledger. When wired, records survive
 * plugin reloads (advisor_status keeps its history across config-write reload
 * bursts) and per-consult spend becomes attributable. Only records are
 * stored — never prompts.
 */
export interface ConsultPersistence {
  load(): Promise<ConsultRecord[] | undefined>
  save(records: ConsultRecord[]): Promise<void>
}

/**
 * Policy: the durable copy caps stored advice at 2000 characters — enough for
 * advisor_status replay after a reload, without turning plugin storage into a
 * transcript archive. The in-memory record keeps the full framed advice for
 * the live session.
 */
export const PERSISTED_ADVICE_CAP = 2_000

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
  private readonly persistence: ConsultPersistence | undefined

  constructor(private readonly clock: ConsultClock = { now: () => Date.now() }, persistence?: ConsultPersistence) {
    this.persistence = persistence
  }

  now(): number {
    return this.clock.now()
  }

  /** Load durable records at setup — BEFORE the lifecycle sweep, so the sweep
   *  can fail entries orphaned by a plugin reload. Call once, before first use. */
  async hydrate(): Promise<void> {
    if (!this.persistence) return
    try {
      const records = await this.persistence.load()
      if (!Array.isArray(records)) return
      for (const r of records) {
        if (r && typeof r.id === "string" && !this.entries.has(r.id)) {
          this.entries.set(r.id, r)
        }
      }
    } catch {
      /* unreadable persistence — start clean; never block consults on it */
    }
  }

  private persist(): void {
    if (!this.persistence) return
    const records = [...this.entries.values()].map((r) =>
      r.advice && r.advice.length > PERSISTED_ADVICE_CAP ? { ...r, advice: r.advice.slice(0, PERSISTED_ADVICE_CAP) + "…[truncated]" } : r,
    )
    this.persistence.save(records).catch(() => {})
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
    this.persist()
    return record
  }

  /** Idempotent: a completed/failed consult never changes state again. */
  complete(id: string, advice: string): void {
    const r = this.entries.get(id)
    if (!r || r.state === "completed" || r.state === "failed") return
    r.state = "completed"
    r.advice = advice
    r.elapsedMs = this.clock.now() - r.startedAt
    this.persist()
  }

  markInjected(id: string): void {
    const r = this.entries.get(id)
    if (r && r.state === "completed") r.delivery = "injected"
    this.persist()
  }

  /** Advice was returned in the tool result itself (sync path) — no injection. */
  markInline(id: string): void {
    const r = this.entries.get(id)
    if (r && r.state === "completed") r.delivery = "inline"
    this.persist()
  }

  /** Idempotent — a reload mid-consult must not double-fail an entry. */
  fail(id: string, error: string): void {
    const r = this.entries.get(id)
    if (!r || r.state === "completed" || r.state === "failed") return
    r.state = "failed"
    r.error = error
    r.elapsedMs = this.clock.now() - r.startedAt
    this.persist()
  }

  /** This session's consults, newest first. */
  list(sessionID: string): ConsultRecord[] {
    return [...this.entries.values()].filter((r) => r.sessionID === sessionID).sort((a, b) => b.startedAt - a.startedAt)
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
   * Reap consults still RUNNING past the lifetime ceiling plus a grace
   * window. Two honest cases: (a) a process restart orphaned the consult
   * (its detached promise died with the old engine), or (b) the consult is
   * genuinely overdue (the engine ceiling timer already failed it in-instance
   * — such entries are `failed` and skipped here). NEVER fail entries inside
   * the window: an in-flight consult owns its slot until it settles, and a
   * re-instantiated ledger must not kill a live detached promise. Idempotent.
   */
  reapStale(ceilingMs: number, graceMs = 30_000): string[] {
    const threshold = this.clock.now() - (ceilingMs + graceMs)
    const reaped: string[] = []
    for (const r of this.entries.values()) {
      if ((r.state === "starting" || r.state === "running") && r.startedAt < threshold) {
        this.fail(r.id, `advisor_not_running — no response within ${Math.round(ceilingMs / 1000)}s (orphaned by restart)`)
        reaped.push(r.id)
      }
    }
    this.persist()
    return reaped
  }

  private trim(): void {
    if (this.entries.size <= MAX_RECORDS) return
    // Prefer evicting terminal records: a running record holds a concurrency
    // slot and its advice may still land. Insertion order breaks ties.
    const terminal = [...this.entries.values()].filter((r) => r.state === "completed" || r.state === "failed")
    if (terminal.length > 0) {
      this.entries.delete(terminal[0]!.id)
      return
    }
    const oldest = this.entries.keys().next().value
    if (oldest !== undefined) this.entries.delete(oldest)
  }
}
