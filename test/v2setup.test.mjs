import assert from "node:assert/strict"
import { test } from "node:test"
import { createV2Plugin } from "../dist/opencode-advisor.js"

/** Minimal fake V2 plugin context — exercises setup wiring end to end. */
function makeCtx(overrides = {}) {
  const captured = {
    tools: [],
    promptHooks: [],
    contextHooks: [],
    commands: [],
    prompts: [],
    storage: new Map(),
  }
  const ctx = {
    options: { advisor: { providerID: "p", id: "a" }, logLevel: "error" },
    storage: {
      get: async (k) => captured.storage.get(k),
      set: async (k, v) => {
        captured.storage.set(k, v)
      },
      remove: async (k) => {
        captured.storage.delete(k)
      },
      scan: async () => ({ entries: [], next: undefined }),
    },
    session: {
      context: async () => [{ type: "user", text: "do the thing" }],
      generate: async () => ({ text: "GENERATED-ADVICE" }),
      hook: async (name, cb) => {
        if (name === "prompt") captured.promptHooks.push(cb)
        if (name === "context") captured.contextHooks.push(cb)
        return { dispose: async () => {} }
      },
      prompt: async (args) => {
        captured.prompts.push(args)
        return {}
      },
      switchModel: async () => {},
      get: async () => ({ model: { providerID: "p", id: "exec" } }),
    },
    tool: {
      transform: async (cb) => {
        const editor = {
          add: (t) => captured.tools.push(t),
          list: () => captured.tools.map((t) => ({ id: t.name })),
        }
        cb(editor)
        return { dispose: async () => {} }
      },
      list: async () => captured.tools.map((t) => ({ id: t.name })),
    },
    command: {
      transform: async (cb) => {
        cb({ add: (d) => captured.commands.push(d) })
        return { dispose: async () => {} }
      },
    },
    model: {
      list: async () => [
        { providerID: "p", id: "a", name: "Advisor A" },
        { providerID: "q", id: "b", name: "Advisor B" },
      ],
    },
    generate: {
      text: async () => ({ text: "UNUSED" }),
    },
    ...overrides,
  }
  return { ctx, captured }
}

test("setup registers the advisor tool and both commands", async () => {
  const { ctx, captured } = makeCtx()
  const plugin = createV2Plugin()
  const cleanup = await plugin.setup(ctx)
  assert.equal(captured.tools.length, 1)
  assert.equal(captured.tools[0].name, "advisor")
  assert.ok(captured.tools[0].description.length > 20)
  assert.deepEqual(
    captured.commands.map((c) => c.name).sort(),
    ["advisor", "advisor-settings"],
  )
  assert.equal(typeof cleanup, "function")
  await cleanup()
})

test("prompt hook appends directive on trigger, skips otherwise", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  assert.equal(captured.promptHooks.length, 1)
  const hook = captured.promptHooks[0]

  const event = { sessionID: "s1", prompt: { text: "give me some advice on caching" } }
  await hook(event)
  assert.ok(event.prompt.text.includes("[advisor requested"), "directive appended")
  assert.ok(event.prompt.text.startsWith("give me some advice on caching"), "user text preserved")

  const plain = { sessionID: "s1", prompt: { text: "deploy the cache" } }
  await hook(plain)
  assert.equal(plain.prompt.text, "deploy the cache", "no trigger, no edit")

  const marked = { sessionID: "s1", prompt: { text: 'hi advisor\n\n[advisor requested by user — trigger: "x"]' } }
  await hook(marked)
  assert.equal(marked.prompt.text.match(/\[advisor requested/g).length, 1, "marker prevents doubles")
})

test("advisor tool executes end to end through the fake session", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const tool = captured.tools[0]
  const result = await tool.execute({}, { sessionID: "s9", signal: new AbortController().signal })
  assert.ok(result.content.startsWith("ADVISOR REVIEW"), "framed advice returned")
  assert.ok(result.content.includes("GENERATED-ADVICE"), "sub-call text flows through")
  const health = captured.storage.get("diag:health")
  assert.ok(health, "health key written")
  assert.equal(health.sessionID, "s9")
})

test("/advisor command submits a directive-bearing prompt", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const cmd = captured.commands[0]
  await cmd.execute({ sessionID: "s2", prompt: { text: "review the cache" }, delivery: "steer" })
  assert.equal(captured.prompts.length, 1)
  const submitted = captured.prompts[0]
  assert.equal(submitted.sessionID, "s2")
  assert.ok(submitted.text.includes("review the cache"), "focus preserved")
  assert.ok(submitted.text.includes("[advisor requested"), "directive composed (hook will skip re-append)")
  assert.equal(submitted.delivery, "steer")
})

test("/advisor-settings composes catalog list and config-edit instruction", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const cmd = captured.commands.find((c) => c.name === "advisor-settings")
  assert.ok(cmd, "settings command registered")
  await cmd.execute({ sessionID: "s3", prompt: { text: "prefer cheap" }, delivery: "steer" })
  assert.equal(captured.prompts.length, 1)
  const submitted = captured.prompts[0].text
  assert.ok(submitted.includes("p/a — Advisor A (current)"), "catalog with current marker")
  assert.ok(submitted.includes("q/b — Advisor B"), "all candidates listed")
  assert.ok(submitted.includes("question tool"), "native picker instruction")
  assert.ok(submitted.includes("opencode.json"), "transparent config-edit path")
  assert.ok(submitted.includes("variant"), "variant selection covered")
  assert.ok(submitted.includes("prefer cheap"), "user focus preserved")
})
