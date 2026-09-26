import assert from "node:assert/strict"
import { test } from "node:test"
import { createV1Hooks, frameAdvice, isAdvisorOutputFrame, normalizeV1Messages, normalizeV2Transcript } from "../dist/opencode-advisor.js"

/* ---------------- V2 ---------------- */

test("V2 completed tool: real content extracted, args never presented as output", () => {
  const slices = normalizeV2Transcript([
    { type: "user", text: "fix the bug" },
    {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "bash",
          state: {
            status: "completed",
            input: { command: "npm test", content: "ARGUMENT_DECOY" },
            content: [{ type: "text", text: "REAL_FAILING_TEST_OUTPUT: expected 1 got 2" }],
          },
        },
      ],
    },
  ])
  assert.equal(slices.length, 2)
  assert.equal(slices[1].text, "REAL_FAILING_TEST_OUTPUT: expected 1 got 2")
  assert.ok(!slices[1].text.includes("ARGUMENT_DECOY"), "args must not leak in as output")
  assert.ok(!slices[1].text.startsWith("{"), "no JSON prologue")
})

test("V2 completed tool with file parts notes the omission", () => {
  const slices = normalizeV2Transcript([
    {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "partial" },
              { type: "file", uri: "file:///a.png", mime: "image/png" },
            ],
          },
        },
      ],
    },
  ])
  assert.equal(slices.length, 1)
  assert.ok(slices[0].text.includes("partial"))
  assert.ok(slices[0].text.includes("1 file attachment(s) omitted"))
})

test("V2 error tool surfaces the message with an [error] marker", () => {
  const slices = normalizeV2Transcript([
    {
      type: "assistant",
      content: [
        { type: "tool", name: "bash", state: { status: "error", input: {}, error: { type: "E", message: "exit code 1" } } },
      ],
    },
  ])
  assert.equal(slices.length, 1)
  assert.ok(slices[0].text.includes("[error] exit code 1"))
})

test("V2 streaming/running partials are skipped, not presented as evidence", () => {
  const slices = normalizeV2Transcript([
    {
      type: "assistant",
      content: [
        { type: "tool", name: "bash", state: { status: "streaming", input: '{"partial": "HALF' } },
        { type: "tool", name: "edit", state: { status: "running", input: { file: "a" } } },
      ],
    },
  ])
  assert.equal(slices.length, 0)
})

test("V2 user content-array and parts shapes are read (no dead fallback)", () => {
  const slices = normalizeV2Transcript([
    { type: "user", content: [{ type: "text", text: "FROM_CONTENT_ARRAY" }] },
    { type: "user", parts: [{ type: "text", text: "FROM_PARTS" }] },
  ])
  assert.ok(slices.some((s) => s.text === "FROM_CONTENT_ARRAY"))
  assert.ok(slices.some((s) => s.text === "FROM_PARTS"))
})

test("V2 image-only user turn yields an explicit marker, not silence", () => {
  const slices = normalizeV2Transcript([{ type: "user", text: "", files: [{}, {}] }])
  assert.equal(slices.length, 1)
  assert.ok(slices[0].text.includes("2 image attachment(s)"))
})

test("V2 shell messages and synthetic prompts are captured", () => {
  const slices = normalizeV2Transcript([
    { type: "shell", text: "SHELL_OUT" },
    { type: "synthetic", text: "SYNTH" },
    { type: "system", text: "IGNORED" },
    { type: "idle" },
  ])
  assert.ok(slices.some((s) => s.role === "tool" && s.name === "shell" && s.text === "SHELL_OUT"))
  const syn = slices.find((s) => s.text === "SYNTH")
  assert.ok(syn && syn.name === "synthetic")
  assert.ok(!slices.some((s) => s.text === "IGNORED"))
})

/* ---------------- V1 ---------------- */

test("V1 messages normalize text and completed tool output, skip partials", () => {
  const slices = normalizeV1Messages([
    { info: { role: "user" }, parts: [{ type: "text", text: "V1_TASK" }] },
    {
      info: { role: "assistant" },
      parts: [
        { type: "tool", tool: "bash", state: { status: "completed", output: "V1_OUT" } },
        { type: "tool", tool: "bash", state: { status: "streaming", input: "half" } },
        { type: "tool", tool: "bash", state: { status: "error", error: { message: "V1_ERR" } } },
      ],
    },
  ])
  assert.ok(slices.some((s) => s.text === "V1_TASK"))
  assert.ok(slices.some((s) => s.text === "V1_OUT"))
  assert.ok(slices.some((s) => s.text.includes("[error] V1_ERR")))
  assert.ok(!slices.some((s) => s.text === "half"))
})

/* ---------------- evidence hygiene ---------------- */

test("V2 evidence hygiene: in-flight trailing assistant draft is dropped", () => {
  const slices = normalizeV2Transcript([
    { type: "user", text: "fix the bug" },
    { type: "assistant", content: [{ type: "text", text: "Completed prior turn." }] },
    { type: "user", text: "now also the parser" },
    { type: "assistant", content: [{ type: "text", text: "I'm halfway through a senten" }] },
  ])
  assert.equal(slices.length, 3)
  assert.ok(!slices.some((s) => s.text.startsWith("I'm halfway")), "current-turn draft is not evidence")
  assert.ok(slices.some((s) => s.text === "Completed prior turn."), "completed prior turns survive")
})

test("V2 evidence hygiene: framed advisor replies never re-enter the evidence", () => {
  const framed = frameAdvice("1. Do X.", "zai-coding-plan/glm-5.3")
  const slices = normalizeV2Transcript([
    { type: "user", text: "fix the bug" },
    {
      type: "assistant",
      content: [
        { type: "tool", name: "advisor", state: { status: "completed", content: [{ type: "text", text: framed }] } },
      ],
    },
    { type: "shell", text: framed },
  ])
  assert.equal(slices.length, 1, "only the user slice remains")
  assert.equal(slices[0].role, "user")
  assert.equal(slices[0].text, "fix the bug")
  assert.ok(!slices.some((s) => s.text.includes("ADVISOR REVIEW")), "advisor frames never re-enter evidence")
  assert.equal(isAdvisorOutputFrame(framed), true)
  assert.equal(isAdvisorOutputFrame("ordinary guidance"), false)
})

test("V2 evidence hygiene never empties the transcript (single-slice guard)", () => {
  const slices = normalizeV2Transcript([{ type: "assistant", content: [{ type: "text", text: "only slice" }] }])
  assert.equal(slices.length, 1, "at least one slice is always kept")
})

test("V1 evidence hygiene: trailing draft and framed advisor output are dropped too", () => {
  const framed = frameAdvice("OLD ADVICE BODY", "p/a")
  const slices = normalizeV1Messages([
    { info: { role: "user" }, parts: [{ type: "text", text: "V1_TASK" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "advisor", state: { status: "completed", output: framed } }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "half-finished senten" }] },
  ])
  assert.deepEqual(slices, [{ role: "user", text: "V1_TASK" }])
})

/* ---------------- V1 hooks ---------------- */

test("V1 is manual-only: no system injection without a request; directives deliver once", async () => {
  const hooks = await createV1Hooks(
    {},
    {
      advisor: { providerID: "x", id: "y" },
      source: { kind: "openai-compatible", baseURL: "http://127.0.0.1:9", apiKeyEnv: "NOPE_KEY", model: "m" },
    },
  )
  const chat = hooks["chat.message"]
  const sys = hooks["experimental.chat.system.transform"]

  // Plain messages in two sequential sessions: no timing prompt, no nudge, nothing.
  await chat({ sessionID: "A" }, { parts: [{ type: "text", text: "fix the bug" }] })
  const outA = { system: [] }
  await sys({ sessionID: "A", model: { providerID: "p", id: "flash-x" } }, outA)
  assert.deepEqual(outA.system, [], "session A: nothing is injected without a request")

  await chat({ sessionID: "B" }, { parts: [{ type: "text", text: "write the docs" }] })
  const outB = { system: [] }
  await sys({ sessionID: "B", model: { providerID: "p", id: "flash-x" } }, outB)
  assert.deepEqual(outB.system, [], "session B: manual-only (no cross-session timing leakage)")

  // A trigger-word request still queues a transient, one-shot directive.
  await chat({ sessionID: "A" }, { parts: [{ type: "text", text: "I need advice on the deploy" }] })
  const outA2 = { system: [] }
  await sys({ sessionID: "A", model: { providerID: "p", id: "flash-x" } }, outA2)
  assert.ok(outA2.system.some((s) => s.includes("[advisor requested")), "requested directive delivered")
  const outA3 = { system: [] }
  await sys({ sessionID: "A", model: { providerID: "p", id: "flash-x" } }, outA3)
  assert.deepEqual(outA3.system, [], "delivered once, then consumed")
})
