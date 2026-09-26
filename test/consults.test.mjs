import assert from "node:assert/strict"
import { test } from "node:test"
import { CONSULT_CONCURRENCY, ConsultLedger, runningMessage } from "../dist/opencode-advisor.js"

/** Injectable fake clock — the timeline tests run in milliseconds. */
function fakeClock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

const REC = { sessionID: "s1", mode: "review", model: "p/advisor" }

test("consult ledger: lifecycle starting → running → completed, delivery field separate", () => {
  const clock = fakeClock()
  const ledger = new ConsultLedger(clock)
  const r = ledger.start({ id: "c1", ...REC })
  assert.equal(r.state, "running")
  assert.equal(r.delivery, "pending")
  clock.advance(90_000)
  ledger.complete("c1", "ADVISOR REVIEW by p/advisor (…):\nadvice text")
  const after = ledger.get("c1")
  assert.equal(after?.state, "completed")
  assert.equal(after?.delivery, "pending", "delivery is a field, not a state")
  ledger.markInjected("c1")
  assert.equal(ledger.get("c1")?.delivery, "injected")
  assert.equal(ledger.get("c1")?.elapsedMs, 90_000)
})

test("consult ledger: fail is idempotent — reload mid-consult cannot double-fail", () => {
  const ledger = new ConsultLedger(fakeClock())
  ledger.start({ id: "c1", ...REC })
  ledger.fail("c1", "advisor_not_running — interrupted by plugin reload")
  ledger.fail("c1", "second failure must not overwrite")
  const r = ledger.get("c1")
  assert.equal(r?.state, "failed")
  assert.equal(r?.error, "advisor_not_running — interrupted by plugin reload")
})

test("reaper: consults past ceiling + grace are orphans — in-window consults untouched", () => {
  const clock = fakeClock()
  const ledger = new ConsultLedger(clock)
  // An orphan from a process restart: started 2h ago, ceiling 1h.
  const orphan = ledger.start({ id: "c-orphan", ...REC, startedAt: clock.now() - 7_200_000 })
  // A live consult inside the window: started 90s ago — NEVER touched.
  const live = ledger.start({ id: "c-live", ...REC, startedAt: clock.now() - 90_000 })
  const reaped = ledger.reapStale(3_600_000)
  assert.deepEqual(reaped, ["c-orphan"])
  assert.equal(ledger.get("c-orphan")?.state, "failed")
  assert.equal(ledger.get("c-live")?.state, "running", "in-window consult untouched")
  assert.deepEqual(ledger.reapStale(3_600_000), [], "idempotent second sweep")
})

test("concurrency guard constant is 2", () => {
  assert.equal(CONSULT_CONCURRENCY, 2)
})

test("running message makes the explicit promise", () => {
  const msg = runningMessage("c9", 94_000)
  assert.ok(msg.includes("ADVISOR CONSULT RUNNING"))
  assert.ok(msg.includes("id: c9"))
  assert.ok(msg.includes("You do not need to start another consultation."))
  assert.ok(msg.includes("advisor_status"))
})

test("ledger trims to 100 entries, dropping the oldest", () => {
  const ledger = new ConsultLedger(fakeClock())
  for (let i = 0; i < 105; i++) ledger.start({ id: `c${i}`, ...REC })
  assert.equal(ledger.get("c0"), undefined, "oldest dropped")
  assert.ok(ledger.get("c104"), "newest kept")
})

test("trim prefers evicting terminal records over running ones", () => {
  const ledger = new ConsultLedger(fakeClock())
  ledger.start({ id: "running-keep", ...REC })
  for (let i = 0; i < 100; i++) {
    ledger.start({ id: `t${i}`, ...REC })
    ledger.complete(`t${i}`, "x")
  }
  ledger.start({ id: "new-guy", ...REC }) // trim fires here (101 entries)
  assert.ok(ledger.get("running-keep"), "running record never evicted")
  assert.ok(ledger.get("new-guy"), "newest kept")
  assert.equal(ledger.get("t0"), undefined, "oldest terminal evicted instead")
})

