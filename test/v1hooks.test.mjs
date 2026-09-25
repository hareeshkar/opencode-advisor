import assert from "node:assert/strict"
import { test } from "node:test"
import { createV1Hooks } from "../dist/opencode-advisor.js"

const OPTS = {
  advisor: { providerID: "p", id: "a" },
  source: { kind: "openai-compatible", baseURL: "http://127.0.0.1:9", apiKeyEnv: "NOPE_KEY", model: "m" },
  logLevel: "error",
}

test("v1 chat.message appends directive on trigger word", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "need advice on the deploy" }] }
  await hooks["chat.message"]({ sessionID: "s1" }, output)
  assert.ok(output.parts[0].text.includes("[advisor requested"), "directive appended")
  assert.ok(output.parts[0].text.startsWith("need advice on the deploy"), "original text preserved")
})

test("v1 chat.message leaves non-trigger messages alone", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "deploy the thing" }] }
  await hooks["chat.message"]({ sessionID: "s1" }, output)
  assert.equal(output.parts[0].text, "deploy the thing")
})

test("v1 chat.message skips when marker already present (idempotent)", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const before = 'ask advisor now\n\n[advisor requested by user — trigger: "x"] do it'
  const output = { parts: [{ type: "text", text: before }] }
  await hooks["chat.message"]({ sessionID: "s1" }, output)
  assert.equal(output.parts[0].text, before)
  assert.equal(output.parts[0].text.match(/\[advisor requested/g).length, 1)
})

test("v1 chat.message tolerates missing/odd shapes", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  await hooks["chat.message"]({ sessionID: "s1" }, {})
  await hooks["chat.message"]({}, undefined)
  await hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "file", uri: "x" }] })
})

test("v1 command.execute.before intercepts the advisor command", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "review this" }] }
  await hooks["command.execute.before"]({ command: "advisor", sessionID: "s1", arguments: "" }, output)
  assert.ok(output.parts[0].text.includes("[advisor requested"), "directive appended")
  assert.ok(output.parts[0].text.startsWith("review this"), "template preserved")
})

test("v1 command.execute.before ignores other commands", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "run tests with advisor present" }] }
  await hooks["command.execute.before"]({ command: "test", sessionID: "s1", arguments: "" }, output)
  assert.equal(output.parts[0].text, "run tests with advisor present")
})
