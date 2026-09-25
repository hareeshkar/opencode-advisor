import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeAdvisorConfigLayers, resolveOptions, shouldNudgeExecutor } from "../dist/opencode-advisor.js"

/* ---------------- tiers ---------------- */

const cases = [
  ["p/deepseek-v4-flash", true],
  ["p/deepseek-v4.1-flash", true],
  ["o/claude-haiku-4-5", true],
  ["z/glm-5.3-flash", true],
  ["m/mimo-v2.6-flash", true],
  ["p/deepseek-v4-pro", false],
  ["m/mimo-v2.6-pro", false],
  ["a/claude-opus-5", false],
  ["a/claude-sonnet-5", false],
  ["z/glm-5.3", false],
  ["z/glm-5.2", false],
  ["x/gpt-5.6-luna", false],
  ["x/grok-4.7", false],
  ["x/minimax-m2.7", false],
  ["openai/o1", false],
  ["openai/o10", false],
  ["x/prod", false],
  ["q/qwen3.6-plus", false],
  ["k/kimi-k2.7-code", false],
]

for (const [model, expected] of cases) {
  test(`tier auto: ${model} → ${expected}`, () => {
    assert.equal(shouldNudgeExecutor(model, "auto"), expected)
  })
}

test("mode on/off override tiers; undefined model never nudges", () => {
  assert.equal(shouldNudgeExecutor("a/claude-opus-5", "on"), true)
  assert.equal(shouldNudgeExecutor("p/deepseek-v4-flash", "off"), false)
  assert.equal(shouldNudgeExecutor(undefined, "auto"), false)
  assert.equal(shouldNudgeExecutor(undefined, "on"), true)
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
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, maxUsesPerTask: 0 }), /1 and 50/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, nudge: "sometimes" }), /auto\|on\|off/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a" } }), /providerID, id/)
})

test("nudge defaults to off (credit-conscious: no autonomous spend)", () => {
  const o = resolveOptions({ advisor: { providerID: "p", id: "m" } })
  assert.equal(o.nudge, "off")
})

test("human budgets: 64k / 128k / 500k / 1.5m parse to chars", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  assert.equal(resolveOptions({ ...base, transcriptBudgetChars: "64k" }).prune.transcriptBudgetChars, 64_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetChars: "128k" }).prune.transcriptBudgetChars, 128_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetChars: "500k" }).prune.transcriptBudgetChars, 500_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetChars: "1.5m" }).prune.transcriptBudgetChars, 1_500_000)
  assert.equal(resolveOptions({ ...base, maxToolOutputChars: "3k" }).prune.maxToolOutputChars, 3_000)
  assert.throws(() => resolveOptions({ ...base, transcriptBudgetChars: "huge" }), /size like "64k"/)
})

test("presets tune the curve; explicit options override them", () => {
  const economy = resolveOptions({ advisor: { providerID: "p", id: "m" }, preset: "economy" })
  assert.equal(economy.maxUsesPerTask, 1)
  assert.equal(economy.prune.transcriptBudgetChars, 16_000)
  assert.equal(economy.adviceWordBudget, 80)

  const exhaustive = resolveOptions({ advisor: { providerID: "p", id: "m" }, preset: "exhaustive" })
  assert.equal(exhaustive.maxUsesPerTask, 8)
  assert.equal(exhaustive.prune.transcriptBudgetChars, 500_000)

  const overridden = resolveOptions({ advisor: { providerID: "p", id: "m" }, preset: "economy", maxUsesPerTask: 4 })
  assert.equal(overridden.maxUsesPerTask, 4)

  assert.throws(() => resolveOptions({ advisor: { providerID: "p", id: "m" }, preset: "turbo" }), /must be one of/)
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
    { maxUsesPerTask: 3, transcriptBudgetChars: "64k" },
    { logLevel: "debug" },
  ])
  assert.equal(merged.maxUsesPerTask, 3)
  assert.equal(merged.transcriptBudgetChars, "64k")
  assert.equal(merged.logLevel, "debug")
  const opts = resolveOptions(merged)
  assert.equal(opts.prune.transcriptBudgetChars, 64_000)
  assert.equal(opts.advisor.providerID, "a")
})
