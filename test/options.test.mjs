import assert from "node:assert/strict"
import { test } from "node:test"
import { PRESETS, mergeAdvisorConfigLayers, normalizeAdvisorMode, resolveOptions } from "../dist/opencode-advisor.js"

/* ---------------- mode ids ---------------- */

test("normalizeAdvisorMode: review/agent plus the review-agent alias", () => {
  assert.equal(normalizeAdvisorMode("review"), "review")
  assert.equal(normalizeAdvisorMode("agent"), "agent")
  assert.equal(normalizeAdvisorMode("review-agent"), "agent")
  assert.equal(normalizeAdvisorMode("review+agent"), "agent")
  assert.equal(normalizeAdvisorMode("bogus"), undefined)
})

test("advisorMode accepts the review-agent alias and rejects unknown modes", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  assert.equal(resolveOptions({ ...base, advisorMode: "review" }).advisorMode, "review")
  assert.equal(resolveOptions({ ...base, advisorMode: "agent" }).advisorMode, "agent")
  assert.equal(resolveOptions({ ...base, advisorMode: "review-agent" }).advisorMode, "agent", "alias normalizes to agent")
  assert.equal(resolveOptions({ ...base, advisorMode: "review+agent" }).advisorMode, "agent")
  assert.throws(() => resolveOptions({ ...base, advisorMode: "nudge" }), /review\|agent\|review-agent/)
})

/* ---------------- validation ---------------- */

test("array options throw loudly instead of becoming {}", () => {
  assert.throws(() => resolveOptions([]), /must be an object, got an array/)
})

test("missing advisor resolves to the unconfigured state (safe default)", () => {
  const o = resolveOptions({})
  assert.equal(o.advisor.providerID, "")
  assert.equal(o.advisor.id, "")
})

test("source-only config is accepted (V1 path)", () => {
  const o = resolveOptions({
    source: { kind: "openai-compatible", baseURL: "http://x", apiKeyEnv: "K", model: "m" },
  })
  assert.equal(o.advisor.providerID, "")
  assert.equal(o.source.model, "m")
})

test("explicit options beat environment", () => {
  process.env.ADVISOR_PROVIDER = "env-p"
  process.env.ADVISOR_MODEL = "env-m"
  try {
    const o = resolveOptions({ advisor: { providerID: "opt-p", id: "opt-m" } })
    assert.equal(o.advisor.providerID, "opt-p")
    const e = resolveOptions({})
    assert.equal(e.advisor.providerID, "env-p")
    assert.equal(e.advisor.id, "env-m")
  } finally {
    delete process.env.ADVISOR_PROVIDER
    delete process.env.ADVISOR_MODEL
  }
})

test("out-of-range values throw with bounds", () => {
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, maxUsesPerTask: 0 }), /1 and 200/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, adviceTokenBudget: 255 }), /256 and 200000/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, adviceTokenBudget: 200_001 }), /256 and 200000/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a" } }), /providerID, id/)
})

/* ---------------- token budgets ---------------- */

test("defaults sit at the measured peak, not the maximum: 32k context + 8k advice", () => {
  const o = resolveOptions({})
  assert.equal(o.transcriptBudgetTokens, 32_000, "LongCodeBench bug-fix peak is 32K")
  assert.equal(o.prune.transcriptBudgetChars, 128_000, "pruner budget derives at CHARS_PER_TOKEN")
  assert.equal(o.adviceTokenBudget, 8_000, "default = balanced preset")
  assert.equal(o.maxUsesPerTask, 3)
  assert.equal(o.maxToolOutputTokens, 750, "per-tool cap is a token budget")
  assert.equal(o.prune.maxToolOutputChars, 3_000, "750 tokens ≈ 3,000 chars for the pruner")
  assert.equal(o.pruning, "standard", "pruning defaults to standard")
})

test("adviceTokenBudget spans 256..200K — the real provider ceiling class", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  assert.equal(resolveOptions({ ...base, adviceTokenBudget: 256 }).adviceTokenBudget, 256)
  assert.equal(resolveOptions({ ...base, adviceTokenBudget: 200_000 }).adviceTokenBudget, 200_000)
  assert.throws(() => resolveOptions({ ...base, adviceTokenBudget: 255 }), /256 and 200000/)
  assert.throws(() => resolveOptions({ ...base, adviceTokenBudget: 200_001 }), /256 and 200000/)
})

test("human budgets: transcriptBudgetTokens (64k/500k) parse; chars derive at ≈4/token", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  assert.equal(resolveOptions({ ...base, transcriptBudgetTokens: "64k" }).transcriptBudgetTokens, 64_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetTokens: "64k" }).prune.transcriptBudgetChars, 256_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetTokens: "1m" }).prune.transcriptBudgetChars, 4_000_000)
  assert.equal(resolveOptions({ ...base, maxToolOutputTokens: "3k" }).prune.maxToolOutputChars, 12_000)
  // Legacy char key still works: divided by CHARS_PER_TOKEN into the token budget.
  assert.equal(resolveOptions({ ...base, maxToolOutputChars: "3k" }).maxToolOutputTokens, 750)
  assert.equal(resolveOptions({ ...base, maxToolOutputChars: "3k" }).prune.maxToolOutputChars, 3_000)
  assert.throws(() => resolveOptions({ ...base, transcriptBudgetTokens: "2m" }), /1000 and 1000000/)
  assert.throws(() => resolveOptions({ ...base, transcriptBudgetTokens: "huge" }), /size like "64k"/)
})

test("presets tune the token curve; explicit options override them", () => {
  const ref = { advisor: { providerID: "p", id: "m" } }

  const economy = resolveOptions({ ...ref, preset: "economy" })
  assert.equal(economy.maxUsesPerTask, 1)
  assert.equal(economy.transcriptBudgetTokens, 16_000)
  assert.equal(economy.prune.transcriptBudgetChars, 64_000)
  assert.equal(economy.adviceTokenBudget, 4_000)

  const balanced = resolveOptions({ ...ref, preset: "balanced" })
  assert.equal(balanced.maxUsesPerTask, 3)
  assert.equal(balanced.transcriptBudgetTokens, 32_000)
  assert.equal(balanced.adviceTokenBudget, 8_000)

  const thorough = resolveOptions({ ...ref, preset: "thorough" })
  assert.equal(thorough.maxUsesPerTask, 5)
  assert.equal(thorough.transcriptBudgetTokens, 64_000)
  assert.equal(thorough.adviceTokenBudget, 16_000)

  const exhaustive = resolveOptions({ ...ref, preset: "exhaustive" })
  assert.equal(exhaustive.maxUsesPerTask, 8)
  assert.equal(exhaustive.transcriptBudgetTokens, 128_000)
  assert.equal(exhaustive.prune.transcriptBudgetChars, 512_000)
  assert.equal(exhaustive.adviceTokenBudget, 32_000)

  const overridden = resolveOptions({ ...ref, preset: "economy", maxUsesPerTask: 4 })
  assert.equal(overridden.maxUsesPerTask, 4)
  const adviceOverride = resolveOptions({ ...ref, preset: "economy", adviceTokenBudget: 6_000 })
  assert.equal(adviceOverride.adviceTokenBudget, 6_000, "explicit advice budget beats the preset")

  assert.throws(() => resolveOptions({ ...ref, preset: "turbo" }), /must be one of/)
})

test("maxAttempts: derived by default, explicit when set", () => {
  const derived = resolveOptions({ advisor: { providerID: "p", id: "m" }, maxUsesPerTask: 2 })
  assert.equal(derived.maxAttempts, 8) // 2*3+2
  const explicit = resolveOptions({ advisor: { providerID: "p", id: "m" }, maxAttempts: 12 })
  assert.equal(explicit.maxAttempts, 12)
})

test("config layers merge: later wins, nested objects replaced whole", () => {
  const merged = mergeAdvisorConfigLayers([
    { maxUsesPerTask: 1, advisor: { providerID: "a", id: "x" }, preset: "economy" },
    { maxUsesPerTask: 3, transcriptBudgetTokens: "64k" },
    { logLevel: "debug" },
  ])
  assert.equal(merged.maxUsesPerTask, 3)
  assert.equal(merged.transcriptBudgetTokens, "64k")
  assert.equal(merged.logLevel, "debug")
  const opts = resolveOptions(merged)
  assert.equal(opts.prune.transcriptBudgetChars, 256_000)
  assert.equal(opts.advisor.providerID, "a")
})

test("patience is uniform: presets never set the wait or the ceiling", () => {
  for (const preset of ["economy", "balanced", "thorough", "exhaustive"]) {
    const o = resolveOptions({ advisor: { providerID: "p", id: "m" }, preset })
    assert.equal(o.advisorResponseWaitMs, 90_000, `${preset} wait is 90s for every preset`)
    assert.equal(o.maxConsultMs, 3_600_000, `${preset} ceiling is 1h for every preset`)
  }
})

test("advisorResponseWaitMs: deprecated timeoutMs alias, precedence, and clamp", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  const alias = resolveOptions({ ...base, timeoutMs: 120_000 })
  assert.equal(alias.advisorResponseWaitMs, 120_000, "timeoutMs maps to the response wait")
  // The wait window is now genuinely patient: 1ms..1h. A 10s wait is legal.
  assert.equal(resolveOptions({ ...base, advisorResponseWaitMs: 1 }).advisorResponseWaitMs, 1)
  assert.equal(resolveOptions({ ...base, advisorResponseWaitMs: 3_600_000 }).advisorResponseWaitMs, 3_600_000)
  assert.throws(() => resolveOptions({ ...base, advisorResponseWaitMs: 0 }), /between 1 and 3600000/)
  assert.throws(() => resolveOptions({ ...base, advisorResponseWaitMs: 3_600_001 }), /between 1 and 3600000/)
  const both = resolveOptions({ ...base, timeoutMs: 120_000, advisorResponseWaitMs: 30_000 })
  assert.equal(both.advisorResponseWaitMs, 30_000, "new key wins when both set")
  const clamped = resolveOptions({ ...base, advisorResponseWaitMs: 600_000, maxConsultMs: 300_000 })
  assert.equal(clamped.maxConsultMs, 600_000, "ceiling raised to cover the wait window")
  // The ceiling itself is not a cost knob: 7 days is legal, not clamped down.
  assert.equal(
    resolveOptions({ ...base, maxConsultMs: 86_400_000 }).maxConsultMs,
    86_400_000,
    "a day-long ceiling is honoured verbatim",
  )
  assert.equal(resolveOptions({ ...base, maxUsesPerTask: 200 }).maxUsesPerTask, 200)
  assert.throws(() => resolveOptions({ ...base, maxUsesPerTask: 201 }), /1 and 200/)
})


/* ---------- deprecation notices are migration notices, not per-call noise ---------- */

/** Collect console.warn output for a run of resolves. The first resolve is
 *  done with the real console because an earlier test in this same process may
 *  already have damped it — the contract under test is only that repeats add
 *  no NEW notice, which is order-independent by construction. */
function warningsAfterFirst(options, times) {
  resolveOptions(options)
  const seen = []
  const real = console.warn
  console.warn = (m) => seen.push(String(m))
  try {
    for (let i = 0; i < times; i++) resolveOptions(options)
  } finally {
    console.warn = real
  }
  return seen
}

test("deprecation warnings do not repeat on every resolve", () => {
  // Config is hot-reloaded by design, so resolveOptions runs per consult. An
  // undamped warning becomes log spam that trains readers to ignore the one
  // line that matters.
  const legacy = { advisor: { providerID: "p", id: "m" }, timeoutMs: 120_000, maxToolOutputChars: "3k" }
  assert.deepEqual(warningsAfterFirst(legacy, 5), [], "five further resolves emit no new notice")
  // And the conversion the notice describes is applied every time regardless.
  assert.equal(resolveOptions(legacy).advisorResponseWaitMs, 120_000)
  assert.equal(resolveOptions(legacy).maxToolOutputTokens, 750)
})

test("a stable validation warning does not repeat, but the correction still applies", () => {
  const bad = { advisor: { providerID: "p", id: "m" }, maxConsultMs: 1_000, advisorResponseWaitMs: 60_000 }
  assert.deepEqual(warningsAfterFirst(bad, 4), [], "a stable misconfiguration stays quiet")
  assert.equal(resolveOptions(bad).maxConsultMs, 60_000, "the ceiling is still raised to cover the wait")
})

/* ---------- the evidence ceiling: honest about when more is worse ---------- */

test("a context budget past the measured peak is honoured but flagged", () => {
  const real = console.warn
  const seen = []
  console.warn = (m) => seen.push(String(m))
  try {
    // Validated and applied verbatim — the plugin never silently trims a
    // number the user chose.
    const o = resolveOptions({ advisor: { providerID: "p", id: "m" }, transcriptBudgetTokens: 987_654 })
    assert.equal(o.transcriptBudgetTokens, 987_654, "the value is honoured exactly")
  } finally {
    console.warn = real
  }
  const advisory = seen.find((m) => m.includes("past the ~128000-token ceiling"))
  assert.ok(advisory, `the user is told accuracy falls past the peak (got ${JSON.stringify(seen)})`)
  assert.ok(advisory.includes("WEAKER"), "the message says it plainly")
  assert.ok(advisory.includes('pruning:"none"'), "it points at the real alternative for more reach")
})

test("an advice budget past the overthinking threshold is flagged", () => {
  const real = console.warn
  const seen = []
  console.warn = (m) => seen.push(String(m))
  try {
    resolveOptions({ advisor: { providerID: "p", id: "m" }, adviceTokenBudget: 123_456 })
  } finally {
    console.warn = real
  }
  const advisory = seen.find((m) => m.includes("compounding errors"))
  assert.ok(advisory, `the overthinking risk is named (got ${JSON.stringify(seen)})`)
})

test("every preset sits inside the measured region", () => {
  // The preset ladder is a claim about where models still reason well. If a
  // preset ever drifts past the ceiling, the default the user ships is the one
  // measured to produce weaker advice — so this is a real invariant, not a
  // snapshot of today's numbers.
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.ok(
      p.transcriptBudgetTokens !== undefined,
      `${name} declares a context budget`,
    )
    assert.ok(
      p.adviceTokenBudget <= 32_000,
      `${name} advice (${p.adviceTokenBudget}) stays at or below the 32K overthinking threshold`,
    )
  }
  const contexts = Object.values(PRESETS).map((p) => Number(String(p.transcriptBudgetTokens).replace("k", "000")))
  assert.ok(
    Math.max(...contexts) <= 128_000,
    `no preset exceeds the 128K measured ceiling (max ${Math.max(...contexts)})`,
  )
  assert.ok(
    Math.min(...contexts) >= 8_000,
    "no preset is so small it cannot hold a real task",
  )
})

test("context + advice past a 1M window is flagged as an over-subscription", () => {
  const real = console.warn
  const seen = []
  console.warn = (m) => seen.push(String(m))
  try {
    // 900K + 150K = 1.05M, i.e. genuinely over-subscribed for a 1M window.
    resolveOptions({ advisor: { providerID: "p", id: "m" }, transcriptBudgetTokens: 900_000, adviceTokenBudget: 150_000 })
  } finally {
    console.warn = real
  }
  assert.ok(
    seen.some((m) => m.includes("past the 1000000-token reference window")),
    `the shared-budget over-subscription is explained (got ${JSON.stringify(seen)})`,
  )
})
