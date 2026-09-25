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

test("noteStep: timing on first injectable call only, nudge respects mode", async () => {
  const engine = new AdvisorEngine({ ...OPTS, nudge: "on" }, makeHost())
  const first = engine.noteStep("s9", true)
  assert.equal(first.injectTiming, true)
  assert.equal(first.injectNudge, false)
  const second = engine.noteStep("s9", true)
  assert.equal(second.injectTiming, false)
  assert.equal(second.injectNudge, true)
  const third = engine.noteStep("s9", true)
  assert.equal(third.injectNudge, false, "nudge fires once per task")
})

test("noteStep: canInject=false defers timing without consuming it (F2 hole 3)", async () => {
  const engine = new AdvisorEngine({ ...OPTS, nudge: "on" }, makeHost())
  const blocked = engine.noteStep("s11", true, false)
  assert.equal(blocked.injectTiming, false, "no injection when system not writable")
  assert.equal(blocked.injectNudge, false)
  const next = engine.noteStep("s11", true, true)
  assert.equal(next.injectTiming, true, "timing not latched by the blocked call")
})

test("noteStep: nudge suppressed after advisor use", async () => {
  const engine = new AdvisorEngine({ ...OPTS, nudge: "on" }, makeHost())
  engine.markAdvisorUsed("s12")
  engine.noteStep("s12", true)
  const second = engine.noteStep("s12", true)
  assert.equal(second.injectNudge, false)
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

test("hook-delivery warning fires once when injections never land", async () => {
  const warnings = []
  const host = makeHost({ log: (level, msg) => { if (level === "warn") warnings.push(msg) } })
  const engine = new AdvisorEngine(OPTS, host)
  for (let i = 0; i < 4; i++) engine.noteStep("hw", false, false)
  await engine.consult("hw", new AbortController().signal)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes("context hooks"))
})

test("health() snapshots task state for diagnostics", () => {
  const engine = new AdvisorEngine(OPTS, makeHost())
  assert.deepEqual(engine.health("nope"), {
    calls: 0,
    attempts: 0,
    steps: 0,
    timingInjected: false,
    advisorUsed: false,
    nudged: false,
  })
  engine.noteStep("h1", true)
  const h = engine.health("h1")
  assert.equal(h.steps, 1)
  assert.equal(h.timingInjected, true)
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
test("prompt-enforced budget appears in the advisor prompt", async () => {
  let seenPrompt = ""
  const host = makeHost({ runAdvisor: async (p) => { seenPrompt = p; return "ok advice" } })
  const engine = new AdvisorEngine({ ...OPTS, adviceWordBudget: 80 }, host)
  await engine.consult("s10", new AbortController().signal)
  assert.ok(seenPrompt.includes("under 80 words"), "budget instruction present")
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
