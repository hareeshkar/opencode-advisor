import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveOptions, shouldNudgeExecutor } from "../dist/opencode-advisor.js"

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

test("missing advisor without source throws with guidance", () => {
  assert.throws(() => resolveOptions({}), /no advisor model configured/)
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
