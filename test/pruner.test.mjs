import assert from "node:assert/strict"
import { test } from "node:test"
import { pruneTranscript } from "../dist/opencode-advisor.js"

const OPTS = { maxToolOutputChars: 200, transcriptBudgetChars: 1_000 }

test("budget is never exceeded", () => {
  const slices = Array.from({ length: 50 }, (_, i) => ({
    role: "user",
    text: `message number ${i} ${"x".repeat(100)}`,
  }))
  const { text, stats } = pruneTranscript(slices, OPTS)
  assert.ok(text.length <= OPTS.transcriptBudgetChars + 200, `text ${text.length} over budget`)
  assert.ok(stats.outChars <= OPTS.transcriptBudgetChars + 200)
  assert.ok(stats.droppedSlices > 0)
})

test("recency wins: newest content survives", () => {
  const slices = [
    { role: "user", text: "old task at the start" },
    ...Array.from({ length: 30 }, (_, i) => ({ role: "tool", name: "read", text: `output ${i} ${"y".repeat(150)}` })),
    { role: "assistant", text: "the most recent assistant conclusion CRITICAL_MARKER" },
  ]
  const { text } = pruneTranscript(slices, OPTS)
  assert.ok(text.includes("CRITICAL_MARKER"), "newest assistant slice must survive")
})

test("original task is pinned even when budget is tight", () => {
  const slices = [
    { role: "user", text: "THE_ORIGINAL_TASK build a worker pool with graceful shutdown" },
    ...Array.from({ length: 40 }, (_, i) => ({ role: "tool", name: "bash", text: `noise ${i} ${"z".repeat(150)}` })),
  ]
  const { text } = pruneTranscript(slices, OPTS)
  assert.ok(text.includes("THE_ORIGINAL_TASK"), "first user slice must be pinned")
})

test("noisy tool output is dropped entirely", () => {
  const slices = [
    {
      role: "tool",
      name: "bash",
      text: "npm warn deprecated foo@1.0.0\nnpm warn deprecated bar@2.0.0\nadded 312 packages in 14s\nnpm warn something",
    },
    { role: "user", text: "keep me" },
  ]
  const { text, stats } = pruneTranscript(slices, OPTS)
  assert.ok(!text.includes("npm warn"), "noise slice must be dropped")
  assert.ok(text.includes("keep me"))
  assert.ok(stats.droppedSlices >= 1)
})

test("long tool outputs are head+tail truncated with elision marker", () => {
  const long = `HEAD_MARKER_COMMAND_RAN\n${"a".repeat(5_000)}\nTAIL_ERROR_FAILED`
  const { text, stats } = pruneTranscript([{ role: "tool", name: "bash", text: long }], OPTS)
  assert.ok(text.includes("HEAD_MARKER_COMMAND_RAN"), "head preserved")
  assert.ok(text.includes("TAIL_ERROR_FAILED"), "tail preserved (errors live at the tail)")
  assert.ok(text.includes("elided"), "elision marker present")
  assert.ok(stats.truncatedSlices === 1)
})

test("ANSI escapes are stripped", () => {
  const { text } = pruneTranscript([{ role: "tool", name: "bash", text: "\x1b[32mgreen text\x1b[0m done" }], OPTS)
  assert.ok(!text.includes("\x1b"), "no escape codes remain")
  assert.ok(text.includes("green text"))
})

test("empty input yields empty output", () => {
  const { text } = pruneTranscript([], OPTS)
  assert.equal(text, "")
})

test("deterministic: same input → same output", () => {
  const slices = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "tool" : "user", text: `s${i} ${"d".repeat(90)}` }))
  const a = pruneTranscript(slices, OPTS).text
  const b = pruneTranscript(slices, OPTS).text
  assert.equal(a, b)
})
