import assert from "node:assert/strict"
import { test } from "node:test"
import { replaceSystemInBody } from "../dist/opencode-advisor.js"

const MARKER = "<<advisor-plugin>>"
const T = ["DIRECTIVE-ONE", "DIRECTIVE-TWO"]
const BLOCK = `${MARKER}\n${T.join("\n\n")}`

test("anthropic: string system is appended", () => {
  const r = replaceSystemInBody(JSON.stringify({ system: "base", messages: [] }), T, MARKER)
  assert.ok(r)
  assert.equal(r.format, "anthropic")
  assert.equal(JSON.parse(r.body).system, `base\n\n${BLOCK}`)
})

test("anthropic: block-array system gets a text block appended", () => {
  const r = replaceSystemInBody(JSON.stringify({ system: [{ type: "text", text: "base" }], messages: [] }), T, MARKER)
  assert.ok(r)
  const sys = JSON.parse(r.body).system
  assert.equal(sys.length, 2)
  assert.equal(sys[1].text, BLOCK)
})

test("anthropic: absent system + max_tokens creates the array", () => {
  const r = replaceSystemInBody(JSON.stringify({ max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }), T, MARKER)
  assert.ok(r)
  assert.equal(r.format, "anthropic")
  assert.equal(JSON.parse(r.body).system[0].text, BLOCK)
})

test("responses: instructions string is appended; created when absent", () => {
  const withIns = replaceSystemInBody(JSON.stringify({ instructions: "base", input: [] }), T, MARKER)
  assert.ok(withIns)
  assert.equal(withIns.format, "responses")
  assert.ok(JSON.parse(withIns.body).instructions.startsWith(`base\n\n${BLOCK}`))
  const without = replaceSystemInBody(JSON.stringify({ input: [] }), T, MARKER)
  assert.ok(without)
  assert.equal(JSON.parse(without.body).instructions, BLOCK)
})

test("chat: system message exists → directive appended as TRAILING system message", () => {
  const r = replaceSystemInBody(
    JSON.stringify({ model: "m", messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] }),
    T,
    MARKER,
  )
  assert.ok(r)
  assert.equal(r.format, "chat")
  const msgs = JSON.parse(r.body).messages
  assert.equal(msgs[0].content, "base", "original system untouched")
  assert.equal(msgs[msgs.length - 1].role, "system")
  assert.equal(msgs[msgs.length - 1].content, BLOCK)
})

test("chat: no system message → one is inserted first", () => {
  const r = replaceSystemInBody(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }), T, MARKER)
  assert.ok(r)
  const msgs = JSON.parse(r.body).messages
  assert.equal(msgs[0].role, "system")
  assert.equal(msgs[0].content, BLOCK)
  assert.equal(msgs[1].role, "user")
})

test("idempotent: marker already present → no rewrite", () => {
  const body = JSON.stringify({ system: `base ${MARKER} already`, messages: [] })
  assert.equal(replaceSystemInBody(body, T, MARKER), undefined)
})

test("no-op cases: empty texts, malformed JSON, non-object, unknown shape", () => {
  assert.equal(replaceSystemInBody(JSON.stringify({ messages: [] }), [], MARKER), undefined)
  assert.equal(replaceSystemInBody("not json{", T, MARKER), undefined)
  assert.equal(replaceSystemInBody("[1,2,3]", T, MARKER), undefined)
  assert.equal(replaceSystemInBody(JSON.stringify({ foo: "bar" }), T, MARKER), undefined)
})

test("body round-trips all other fields untouched", () => {
  const original = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }], temperature: 0.5 }
  const r = replaceSystemInBody(JSON.stringify(original), T, MARKER)
  assert.ok(r)
  const out = JSON.parse(r.body)
  assert.equal(out.model, "m")
  assert.equal(out.temperature, 0.5)
  assert.equal(out.max_tokens, 10)
})

test("extractToolNames reads both tool shapes and namespaced advisor entries", async () => {
  const { extractToolNames } = await import("../dist/opencode-advisor.js")
  assert.deepEqual(
    extractToolNames(JSON.stringify({ tools: [{ type: "function", function: { name: "read" } }, { name: "advisor" }] })),
    ["read", "advisor"],
  )
  assert.deepEqual(extractToolNames(JSON.stringify({ tools: [{ function: { name: "default_advisor" } }] })), ["default_advisor"])
  assert.deepEqual(extractToolNames("not json"), [])
  assert.deepEqual(extractToolNames(JSON.stringify({ messages: [] })), [])
})
