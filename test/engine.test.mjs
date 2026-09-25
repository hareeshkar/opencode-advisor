import assert from "node:assert/strict"
import { test } from "node:test"
import { AdvisorEngine } from "../dist/opencode-advisor.js"

const OPTS = {
  advisor: { providerID: "test", id: "advisor-x" },
  maxUsesPerTask: 2,
  adviceWordBudget: 120,
  timeoutMs: 50,
  prune: { maxToolOutputChars: 200, transcriptBudgetChars: 1_000 },
  nudge: "off",
  injectTimingPrompt: true,
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

test("hard output cap trims runaway advice at a word boundary", async () => {
  const host = makeHost({ runAdvisor: async () => "word ".repeat(2_000) })
  const engine = new AdvisorEngine({ ...OPTS, adviceWordBudget: 50 }, host)
  const r = await engine.consult("s8", new AbortController().signal)
  assert.equal(r.ok, true)
  assert.ok(r.advice.split(/\s+/).length <= 55, `advice word count ${r.advice.split(/\s+/).length}`)
  assert.ok(r.advice.includes("…[truncated]"))
})

test("noteStep: timing on first step only, nudge respects mode", async () => {
  const engine = new AdvisorEngine({ ...OPTS, nudge: "on" }, makeHost())
  const first = engine.noteStep("s9", "some/haiku-flash", true)
  assert.equal(first.injectTiming, true)
  assert.equal(first.injectNudge, false)
  const second = engine.noteStep("s9", "some/haiku-flash", true)
  assert.equal(second.injectTiming, false)
  assert.equal(second.injectNudge, true)
  const third = engine.noteStep("s9", "some/haiku-flash", true)
  assert.equal(third.injectNudge, false, "nudge fires once per task")
})

test("prompt-enforced budget appears in the advisor prompt", async () => {
  let seenPrompt = ""
  const host = makeHost({ runAdvisor: async (p) => { seenPrompt = p; return "ok advice" } })
  const engine = new AdvisorEngine({ ...OPTS, adviceWordBudget: 80 }, host)
  await engine.consult("s10", new AbortController().signal)
  assert.ok(seenPrompt.includes("under 80 words"), "budget instruction present")
  assert.ok(seenPrompt.includes("<transcript>"), "transcript framed")
  assert.ok(seenPrompt.includes("EVIDENCE"), "injection defense present")
})
