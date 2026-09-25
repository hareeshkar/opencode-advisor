import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_TRIGGERS, findTrigger, hasDirective, triggerDirective } from "../dist/opencode-advisor.js"

test("default triggers cover advice/advisor/get consultation", () => {
  assert.deepEqual([...DEFAULT_TRIGGERS], ["advice", "advisor", "get consultation"])
})

test("findTrigger matches case-insensitively", () => {
  assert.equal(findTrigger("Can I get some ADVICE here?"), "advice")
  assert.equal(findTrigger("Ask the Advisor now"), "advisor")
})

test("findTrigger matches the multi-word trigger", () => {
  assert.equal(findTrigger("I want to get consultation on this"), "get consultation")
})

test("findTrigger returns undefined without triggers", () => {
  assert.equal(findTrigger("hello world, how are you"), undefined)
  assert.equal(findTrigger(""), undefined)
})

test("findTrigger respects a custom list; empty list disables", () => {
  assert.equal(findTrigger("advice please", ["consult"]), undefined)
  assert.equal(findTrigger("please consult the oracle", ["consult"]), "consult")
  assert.equal(findTrigger("advice please", []), undefined)
})

test("hasDirective detects the marker", () => {
  assert.equal(hasDirective("plain text"), false)
  assert.equal(hasDirective(triggerDirective("advisor")), true)
  assert.equal(hasDirective("blah [advisor requested by user — trigger: \"x\"] blah"), true)
})

test("triggerDirective: mention mode distinguishes request-now from permit-later", () => {
  const d = triggerDirective("get consultation", "mention")
  assert.ok(d.includes('"get consultation"'))
  assert.ok(d.includes("asks for consultation now"))
  assert.ok(d.includes("merely permits future use"), "grant clause present")
  assert.ok(d.includes("do NOT call now"))
  assert.ok(d.includes("not_configured"), "relay setup steps on unconfigured")
})

test("triggerDirective: command mode is unconditional", () => {
  const d = triggerDirective("/advisor", "command")
  assert.ok(d.includes("/advisor command"))
  assert.ok(d.includes("FIRST action MUST be a call to the `advisor` tool"))
  assert.ok(d.includes("Do not decide that advisor consultation is unnecessary"))
  assert.ok(!d.includes("merely permit"))
})

test("frugal UX invariants are locked in prompt assets", async () => {
  const { ADVISOR_TOOL_DESCRIPTION, EXECUTOR_TIMING_PROMPT } = await import("../dist/opencode-advisor.js")
  assert.ok(ADVISOR_TOOL_DESCRIPTION.includes("Do NOT call unprompted"), "tool description forbids autonomous calls")
  assert.ok(ADVISOR_TOOL_DESCRIPTION.includes("permitted advisor use"), "grant-gated stuck calls")
  assert.ok(EXECUTOR_TIMING_PROMPT.includes("WITHOUT calling it"), "timing teaches solo-default")
  assert.ok(EXECUTOR_TIMING_PROMPT.includes("ONLY when the user explicitly asks"), "request-gating")
})
