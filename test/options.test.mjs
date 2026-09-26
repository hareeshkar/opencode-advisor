import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeAdvisorConfigLayers, normalizeAdvisorMode, resolveOptions } from "../dist/opencode-advisor.js"

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
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, maxUsesPerTask: 0 }), /1 and 50/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a", id: "b" }, adviceTokenBudget: 100 }), /500 and 64000/)
  assert.throws(() => resolveOptions({ advisor: { providerID: "a" } }), /providerID, id/)
})

/* ---------------- token budgets ---------------- */

test("defaults are token-native: 16k context + 8k advice tokens", () => {
  const o = resolveOptions({})
  assert.equal(o.transcriptBudgetTokens, 16_000)
  assert.equal(o.prune.transcriptBudgetChars, 64_000, "pruner budget derives at ≈4 chars/token")
  assert.equal(o.adviceTokenBudget, 8_000, "default = balanced preset, never below economy")
  assert.equal(o.maxUsesPerTask, 3)
})

test("adviceTokenBudget is validated at 500..64000", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  assert.equal(resolveOptions({ ...base, adviceTokenBudget: 500 }).adviceTokenBudget, 500)
  assert.equal(resolveOptions({ ...base, adviceTokenBudget: 64_000 }).adviceTokenBudget, 64_000)
  assert.throws(() => resolveOptions({ ...base, adviceTokenBudget: 499 }), /500 and 64000/)
  assert.throws(() => resolveOptions({ ...base, adviceTokenBudget: 64_001 }), /500 and 64000/)
})

test("human budgets: transcriptBudgetTokens (64k/500k) parse; chars derive at ≈4/token", () => {
  const base = { advisor: { providerID: "p", id: "m" } }
  assert.equal(resolveOptions({ ...base, transcriptBudgetTokens: "64k" }).transcriptBudgetTokens, 64_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetTokens: "64k" }).prune.transcriptBudgetChars, 256_000)
  assert.equal(resolveOptions({ ...base, transcriptBudgetTokens: "500k" }).prune.transcriptBudgetChars, 2_000_000)
  assert.equal(resolveOptions({ ...base, maxToolOutputChars: "3k" }).prune.maxToolOutputChars, 3_000)
  assert.throws(() => resolveOptions({ ...base, transcriptBudgetTokens: "2m" }), /2000 and 1000000/)
  assert.throws(() => resolveOptions({ ...base, transcriptBudgetTokens: "huge" }), /size like "64k"/)
})

test("presets tune the token curve; explicit options override them", () => {
  const ref = { advisor: { providerID: "p", id: "m" } }

  const economy = resolveOptions({ ...ref, preset: "economy" })
  assert.equal(economy.maxUsesPerTask, 1)
  assert.equal(economy.transcriptBudgetTokens, 8_000)
  assert.equal(economy.prune.transcriptBudgetChars, 32_000)
  assert.equal(economy.adviceTokenBudget, 4_000)

  const balanced = resolveOptions({ ...ref, preset: "balanced" })
  assert.equal(balanced.maxUsesPerTask, 3)
  assert.equal(balanced.transcriptBudgetTokens, 16_000)
  assert.equal(balanced.adviceTokenBudget, 8_000)

  const thorough = resolveOptions({ ...ref, preset: "thorough" })
  assert.equal(thorough.maxUsesPerTask, 5)
  assert.equal(thorough.transcriptBudgetTokens, 32_000)
  assert.equal(thorough.adviceTokenBudget, 16_000)

  const exhaustive = resolveOptions({ ...ref, preset: "exhaustive" })
  assert.equal(exhaustive.maxUsesPerTask, 8)
  assert.equal(exhaustive.transcriptBudgetTokens, 64_000)
  assert.equal(exhaustive.prune.transcriptBudgetChars, 256_000)
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
