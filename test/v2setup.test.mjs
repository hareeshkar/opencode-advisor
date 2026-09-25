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
    rpcHandlers: new Map(),
    switchModelCalls: [],
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
      switchModel: async (args) => {
        captured.switchModelCalls.push(args)
      },
      get: async () => ({ model: { providerID: "p", id: "exec" } }),
    },
    rpc: {
      register: async (definition, handlers) => {
        captured.rpcHandlers.set(definition.id, handlers)
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
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

test("prompt hook queues a transient directive; context hook delivers it invisibly", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  assert.equal(captured.promptHooks.length, 1)
  const promptHook = captured.promptHooks[0]
  const contextHook = captured.contextHooks[0]

  const event = { sessionID: "s1", prompt: { text: "give me some advice on caching" } }
  await promptHook(event)
  assert.equal(event.prompt.text, "give me some advice on caching", "user text never mutates")

  const first = { sessionID: "s1", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await contextHook(first)
  assert.ok(first.system.some((t) => t.text.includes("[advisor requested")), "directive delivered via system")

  const second = { sessionID: "s1", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await contextHook(second)
  assert.ok(!second.system.some((t) => t.text.includes("[advisor requested")), "delivered once, then consumed")

  const plain = { sessionID: "s2", prompt: { text: "deploy the cache" } }
  await promptHook(plain)
  assert.equal(plain.prompt.text, "deploy the cache")

  const settings = { sessionID: "s3", prompt: { text: "open advisor settings" } }
  await promptHook(settings)
  const sys = { sessionID: "s3", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await contextHook(sys)
  assert.ok(!sys.system.some((t) => t.text.includes("[advisor requested")), "settings invocation never queues")
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

test("/advisor command submits lean visible text and queues the directive", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const cmd = captured.commands.find((c) => c.name === "advisor")
  await cmd.execute({ sessionID: "s2", prompt: { text: "review the cache" }, delivery: "steer" })
  assert.equal(captured.prompts.length, 1)
  const submitted = captured.prompts[0]
  assert.equal(submitted.sessionID, "s2")
  assert.equal(submitted.text, "review the cache", "focus only — no boilerplate in the visible prompt")
  assert.equal(submitted.delivery, "steer")

  const sys = { sessionID: "s2", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await captured.contextHooks[0](sys)
  assert.ok(sys.system.some((t) => t.text.includes("[advisor requested")), "directive delivered invisibly")
})

test("/advisor with no focus uses one short line", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const cmd = captured.commands.find((c) => c.name === "advisor")
  await cmd.execute({ sessionID: "s2", prompt: { text: "" }, delivery: "steer" })
  assert.equal(captured.prompts[0].text, "Review the current task with the advisor.")
})

test("RPC set hot-swaps the advisor model and persists an override", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const rpc = captured.rpcHandlers.get("opencode-advisor")
  assert.ok(rpc, "rpc registered")

  const before = await rpc.get()
  assert.equal(before.source, "config")
  assert.equal(before.providerID, "p")

  const updated = await rpc.set({ providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" })
  assert.deepEqual(updated, { providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" })
  const after = await rpc.get()
  assert.equal(after.source, "override")
  assert.equal(captured.storage.get("advisor:override").providerID, "zai-coding-plan")

  // next consult: the sandwich switches the session to the OVERRIDE model
  await captured.tools[0].execute({}, { sessionID: "s9", signal: new AbortController().signal })
  const switched = captured.switchModelCalls.find((c) => c.model.providerID === "zai-coding-plan")
  assert.ok(switched, "override model used for the sub-call")
  assert.equal(switched.model.id, "glm-5.3")
  assert.equal(switched.model.variant, "high")

  const reset = await rpc.reset()
  assert.equal(reset.providerID, "p")
  assert.equal(captured.storage.get("advisor:override"), undefined)
})

test("/advisor-settings composes a lean shortlist and config-edit instruction", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const cmd = captured.commands.find((c) => c.name === "advisor-settings")
  assert.ok(cmd, "settings command registered")
  await cmd.execute({ sessionID: "s3", prompt: { text: "prefer cheap" }, delivery: "steer" })
  assert.equal(captured.prompts.length, 1)
  const submitted = captured.prompts[0].text
  assert.ok(submitted.includes("p/a — Advisor A (current, Recommended)"), "shortlist with current marker")
  assert.ok(submitted.includes("q/b — Advisor B"), "candidates listed")
  assert.ok(submitted.includes("token-lean"), "lean instruction present")
  assert.ok(submitted.includes("question tool"), "native picker instruction")
  assert.ok(submitted.includes("opencode.json"), "transparent config-edit path")
  assert.ok(submitted.includes("variant"), "variant selection covered")
  assert.ok(submitted.includes("prefer cheap"), "user focus preserved")
})

test("unconfigured install loads safely and the tool teaches setup", async () => {
  const { ctx, captured } = makeCtx({ options: { logLevel: "error" } })
  await createV2Plugin().setup(ctx)
  assert.equal(captured.tools.length, 1, "tool still registers so errors can teach")
  const result = await captured.tools[0].execute({}, { sessionID: "s-nc", signal: new AbortController().signal })
  assert.ok(result.content.includes("not_configured"), "error code surfaced")
  assert.ok(result.content.includes("/advisor-settings"), "settings step present")
  assert.ok(result.content.includes("opencode.json"), "declarative step present")
  assert.ok(!result.content.startsWith("ADVISOR REVIEW"), "never framed as advice")
})

test("unconfigured install injects no timing guidance (token discipline)", async () => {
  const { ctx, captured } = makeCtx({ options: { logLevel: "error" } })
  await createV2Plugin().setup(ctx)
  const sys = { sessionID: "s-nc2", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await captured.contextHooks[0](sys)
  assert.equal(sys.system.length, 0, "nothing injected while unconfigured")
})
