import assert from "node:assert/strict"
import { test } from "node:test"
import { createV1Hooks } from "../dist/opencode-advisor.js"

const OPTS = {
  advisor: { providerID: "p", id: "a" },
  source: { kind: "openai-compatible", baseURL: "http://127.0.0.1:9", apiKeyEnv: "NOPE_KEY", model: "m" },
  logLevel: "error",
}

test("v1 trigger queues a transient directive; parts stay untouched", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "need advice on the deploy" }] }
  await hooks["chat.message"]({ sessionID: "s1" }, output)
  assert.equal(output.parts[0].text, "need advice on the deploy", "user text never mutates")
  const sys = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, sys)
  assert.ok(sys.system.some((s) => s.includes("[advisor requested")), "directive delivered via system (transient)")
  const sys2 = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, sys2)
  assert.ok(!sys2.system.some((s) => s.includes("[advisor requested")), "delivered once, then consumed")
})

test("v1 non-trigger messages queue nothing", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "deploy the thing" }] }
  await hooks["chat.message"]({ sessionID: "s1" }, output)
  assert.equal(output.parts[0].text, "deploy the thing")
  const sys = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, sys)
  assert.ok(!sys.system.some((s) => s.includes("[advisor requested")))
})

test("v1 settings invocation queues nothing (never triggers spend)", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const output = { parts: [{ type: "text", text: "open advisor settings please" }] }
  await hooks["chat.message"]({ sessionID: "s1" }, output)
  const sys = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, sys)
  assert.ok(!sys.system.some((s) => s.includes("[advisor requested")))
})

test("v1 chat.message tolerates missing/odd shapes", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  await hooks["chat.message"]({ sessionID: "s1" }, {})
  await hooks["chat.message"]({}, undefined)
  await hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "file", uri: "x" }] })
})

test("v1 command.execute.before queues director for /advisor, assist for settings", async () => {
  const hooks = await createV1Hooks({}, OPTS)
  const advOut = { parts: [{ type: "text", text: "review this" }] }
  await hooks["command.execute.before"]({ command: "advisor", sessionID: "s1", arguments: "" }, advOut)
  assert.equal(advOut.parts[0].text, "review this", "command parts never mutate for /advisor")
  const sys = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, sys)
  assert.ok(sys.system.some((s) => s.includes("[advisor requested")), "advisor directive via system")

  const setOut = { parts: [{ type: "text", text: "choose a model" }] }
  await hooks["command.execute.before"]({ command: "advisor-settings", sessionID: "s2", arguments: "" }, setOut)
  assert.ok(setOut.parts[0].text.includes("[advisor-settings assist]"), "settings assist appended (visible)")
  const sys2 = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s2" }, sys2)
  assert.ok(!sys2.system.some((s) => s.includes("[advisor requested")), "settings never queues consults")
})
