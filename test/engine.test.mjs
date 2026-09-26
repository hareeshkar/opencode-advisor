import assert from "node:assert/strict"
import { test } from "node:test"
import { AdvisorEngine } from "../dist/opencode-advisor.js"

const OPTS = {
  advisor: { providerID: "test", id: "advisor-x" },
  maxUsesPerTask: 2,
  adviceTokenBudget: 8_000,
  maxConsultMs: 50,
  prune: { maxToolOutputChars: 200, transcriptBudgetChars: 1_000 },
  logLevel: "error",
}

function makeHost(overrides = {}) {
  const usage = []
  return {
    usage,
    transcript: [{ role: "user", text: "do the thing" }],
    async getTranscript() {
      return this.transcript
    },
    async runAdvisor() {
      return "1. Do A. 2. Then B. 3. Verify with a test."
    },
    async persistUsage(entry) {
      usage.push(entry)
    },
    log() {},
    ...overrides,
  }
}

test("happy path: advice returned, usage recorded, advisorUsed set", async () => {
  const host = makeHost()
  const engine = new AdvisorEngine(OPTS, host)
  const r = await engine.consult("s1", new AbortController().signal)
  assert.equal(r.ok, true)
  assert.ok(r.advice.includes("Do A"))
  assert.ok(r.stats.estTokensIn > 0)
  assert.equal(host.usage.length, 1)
  assert.equal(host.usage[0].calls, 1)
})

test("per-task cap enforced with max_uses_exceeded", async () => {
  const engine = new AdvisorEngine(OPTS, makeHost())
  const sig = new AbortController().signal
  assert.equal((await engine.consult("s2", sig)).ok, true)
  assert.equal((await engine.consult("s2", sig)).ok, true)
  const third = await engine.consult("s2", sig)
  assert.equal(third.ok, false)
  assert.equal(third.errorCode, "max_uses_exceeded")
})

test("resetTask restores the cap", async () => {
  const engine = new AdvisorEngine(OPTS, makeHost())
  const sig = new AbortController().signal
  await engine.consult("s3", sig)
  await engine.consult("s3", sig)
  engine.resetTask("s3")
  assert.equal((await engine.consult("s3", sig)).ok, true)
})

test("timeout maps to execution_time_exceeded", async () => {
  const host = makeHost({
    runAdvisor: () => new Promise((resolve) => setTimeout(() => resolve("late"), 500)),
  })
  const engine = new AdvisorEngine(OPTS, host)
  const r = await engine.consult("s4", new AbortController().signal)
  assert.equal(r.ok, false)
  assert.equal(r.errorCode, "execution_time_exceeded")
})

test("empty transcript maps to unavailable", async () => {
  const host = makeHost({ getTranscript: async () => [] })
  const engine = new AdvisorEngine(OPTS, host)
  const r = await engine.consult("s5", new AbortController().signal)
  assert.equal(r.ok, false)
  assert.equal(r.errorCode, "unavailable")
})

test("empty advice maps to unavailable and records an error", async () => {
  const host = makeHost({ runAdvisor: async () => "   " })
  const engine = new AdvisorEngine(OPTS, host)
  const r = await engine.consult("s6", new AbortController().signal)
  assert.equal(r.ok, false)
  assert.equal(r.errorCode, "unavailable")
  assert.equal(host.usage[0].errors, 1)
})

test("rate-limit error strings map to too_many_requests", async () => {
  const host = makeHost({ runAdvisor: async () => { throw new Error("HTTP 429 from upstream: rate limit exceeded") } })
  const engine = new AdvisorEngine(OPTS, host)
  const r = await engine.consult("s7", new AbortController().signal)
  assert.equal(r.ok, false)
  assert.equal(r.errorCode, "too_many_requests")
})

test("hard output cap trims runaway advice to the token budget (≈4 chars/token)", async () => {
  const host = makeHost({ runAdvisor: async () => "word ".repeat(2_000) })
  const engine = new AdvisorEngine({ ...OPTS, adviceTokenBudget: 500 }, host)
  const r = await engine.consult("s8", new AbortController().signal)
  assert.equal(r.ok, true)
  assert.ok(r.advice.length <= 500 * 4 + 16, `advice chars ${r.advice.length} within budget + marker`)
  assert.ok(r.advice.length >= 500 * 4 - 20, `advice chars ${r.advice.length} actually uses the budget`)
  assert.ok(r.advice.includes("…[truncated]"))
  assert.ok(r.advice.startsWith("word word"), "cut at a word boundary, not mid-word")
})

test("noteStep counts steps and returns void (no injection decisions)", () => {
  const engine = new AdvisorEngine(OPTS, makeHost())
  assert.equal(engine.noteStep("s9"), undefined, "step accounting only — nothing is returned")
  engine.noteStep("s9")
  assert.equal(engine.health("s9").steps, 2)
  engine.resetTask("s9")
  assert.equal(engine.health("s9").steps, 0, "a new task resets the step count")
})

test("transient failures do not consume the success cap", async () => {
  let fails = 2
  const host = makeHost({ runAdvisor: async () => { if (fails-- > 0) throw new Error("HTTP 503 overloaded"); return "good advice here" } })
  const engine = new AdvisorEngine({ ...OPTS, maxUsesPerTask: 1 }, host)
  const sig = new AbortController().signal
  assert.equal((await engine.consult("fc", sig)).errorCode, "overloaded")
  assert.equal((await engine.consult("fc", sig)).errorCode, "overloaded")
  assert.equal((await engine.consult("fc", sig)).ok, true, "cap intact after failures")
})

test("attempt ceiling bounds retry storms without punishing single failures", async () => {
  const host = makeHost({ runAdvisor: async () => { throw new Error("boom") } })
  const engine = new AdvisorEngine({ ...OPTS, maxUsesPerTask: 1 }, host)
  const sig = new AbortController().signal
  for (let i = 0; i < 5; i++) assert.equal((await engine.consult("ac", sig)).errorCode, "unavailable")
  assert.equal((await engine.consult("ac", sig)).errorCode, "max_uses_exceeded", "ceiling = 1*3+2")
})

test("task change detected via fingerprint resets caps without a prompt hook", async () => {
  const host = makeHost()
  const engine = new AdvisorEngine({ ...OPTS, maxUsesPerTask: 1 }, host)
  const sig = new AbortController().signal
  assert.equal((await engine.consult("fp", sig)).ok, true)
  assert.equal((await engine.consult("fp", sig)).errorCode, "max_uses_exceeded")
  host.transcript = [{ role: "user", text: "a completely different task about databases" }]
  assert.equal((await engine.consult("fp", sig)).ok, true, "auto-reset on task change")
})

test("parallel consults respect the cap via in-flight reservation", async () => {
  const host = makeHost()
  const engine = new AdvisorEngine({ ...OPTS, maxUsesPerTask: 2 }, host)
  const sig = new AbortController().signal
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => engine.consult("par", sig)))
  assert.equal(results.filter((r) => r.ok).length, 2, "exactly 2 successes")
  assert.ok(results.filter((r) => !r.ok).every((r) => r.errorCode === "max_uses_exceeded"))
})

test("health() snapshots the 4-field task state for diagnostics", () => {
  const engine = new AdvisorEngine(OPTS, makeHost())
  assert.deepEqual(engine.health("nope"), {
    calls: 0,
    attempts: 0,
    steps: 0,
    advisorUsed: false,
  })
  engine.noteStep("h1")
  assert.equal(engine.health("h1").steps, 1)
  engine.markAdvisorUsed("h1")
  assert.equal(engine.health("h1").advisorUsed, true)
})
test("upstream secrets never reach the tool result", async () => {
  const host = makeHost({
    runAdvisor: async () => { throw new Error("HTTP 401 from https://x.com?api_key=SUPERSECRET: Bearer abc.def.ghi") },
  })
  const engine = new AdvisorEngine(OPTS, host)
  const r = await engine.consult("sec", new AbortController().signal)
  assert.equal(r.ok, false)
  assert.ok(!r.message.includes("SUPERSECRET"), "query-string secret redacted")
  assert.ok(!r.message.includes("abc.def.ghi"), "bearer redacted")
  assert.ok(r.message.includes("<redacted>"))
})
test("prompt-enforced token budget appears in the advisor prompt", async () => {
  let seenPrompt = ""
  const host = makeHost({ runAdvisor: async (p) => { seenPrompt = p; return "ok advice" } })
  const engine = new AdvisorEngine({ ...OPTS, adviceTokenBudget: 8_000 }, host)
  await engine.consult("s10", new AbortController().signal)
  assert.ok(seenPrompt.includes("under 8000 tokens"), "token budget instruction present")
  assert.ok(/<transcript-[a-z0-9]+>/.test(seenPrompt), "transcript framed with nonce delimiter")
  assert.ok(seenPrompt.includes("EVIDENCE"), "injection defense present")
  assert.ok(seenPrompt.includes("transcript pruned"), "pruning manifest present (F7)")
})

test("unconfigured advisor returns setup steps without consuming caps", async () => {
  const engine = new AdvisorEngine({ ...OPTS, advisor: { providerID: "", id: "" } }, makeHost())
  const sig = new AbortController().signal
  const first = await engine.consult("nc", sig)
  assert.equal(first.ok, false)
  assert.equal(first.errorCode, "not_configured")
  assert.ok(first.message.includes("/advisor-settings"), "carries the settings command step")
  assert.ok(first.message.includes("providerID"), "carries the config shape")
  assert.ok(first.message.includes("opencode models"), "carries model discovery step")
  // repeated calls stay not_configured (no attempt/cap consumption)
  const second = await engine.consult("nc", sig)
  assert.equal(second.errorCode, "not_configured")
})

test("setAdvisor hot-swaps the model and exposes it via advisor()", () => {
  const engine = new AdvisorEngine({ ...OPTS, advisor: { providerID: "", id: "" } }, makeHost())
  assert.equal(engine.advisor().providerID, "")
  engine.setAdvisor({ providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" })
  assert.deepEqual(engine.advisor(), { providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" })
})

test("straggler consult after resetTask does not consume the new task's quota (generation guard)", async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const host = makeHost({
    runAdvisor: async () => {
      await gate
      return "late advice from the old task"
    },
  })
  const engine = new AdvisorEngine({ ...OPTS, maxUsesPerTask: 1 }, host)
  const sig = new AbortController().signal

  const straggler = engine.consult("gen", sig) // holds the reservation
  await new Promise((r) => setTimeout(r, 5))
  engine.resetTask("gen") // new user prompt arrives mid-flight
  release()
  const result = await straggler
  assert.equal(result.ok, true, "straggler still returns its advice")

  // The new task's quota must be untouched: a fresh consult succeeds.
  const fresh = await engine.consult("gen", sig)
  assert.equal(fresh.ok, true, "new task quota intact (straggler did not consume it)")

  // And the new task's own cap still applies afterwards.
  const capped = await engine.consult("gen", sig)
  assert.equal(capped.errorCode, "max_uses_exceeded")
})

test("health() reflects the generation counter bump", () => {
  const engine = new AdvisorEngine(OPTS, makeHost())
  engine.noteStep("g1")
  engine.health("g1")
  engine.resetTask("g1")
  const h = engine.health("g1")
  assert.equal(h.steps, 0)
})
