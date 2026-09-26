import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createV2Plugin } from "../dist/opencode-advisor.js"

/** Minimal fake V2 plugin context — exercises setup wiring end to end. */
function makeCtx(overrides = {}) {
  // Isolate config files per test: a fresh XDG home + a fresh project dir, so
  // no test can see another test's (or the developer's) advisor config.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "advisor-home-"))
  const projectDir = mkdtempSync(join(tmpdir(), "advisor-project-"))
  const captured = {
    tools: [],
    promptHooks: [],
    contextHooks: [],
    httpHooks: [],
    commands: [],
    prompts: [],
    storage: new Map(),
    rpcHandlers: new Map(),
    switchModelCalls: [],
  }
  const ctx = {
    options: { advisor: { providerID: "p", id: "a" }, logLevel: "error" },
    location: { directory: projectDir },
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
        if (name === "http.request") captured.httpHooks.push(cb)
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

test("prompt hook queues a directive; http hook injects it into the request body", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  assert.equal(captured.promptHooks.length, 1)
  const promptHook = captured.promptHooks[0]
  const contextHook = captured.contextHooks[0]
  const httpHook = captured.httpHooks[0]
  assert.ok(httpHook, "http.request hook registered")

  const event = { sessionID: "s1", prompt: { text: "give me some advice on caching" } }
  await promptHook(event)
  assert.equal(event.prompt.text, "give me some advice on caching", "user text never mutates")

  // Context hook only QUEUES (v2.0.16 drops event.system mutations).
  const ctxEvent = { sessionID: "s1", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await contextHook(ctxEvent)
  assert.equal(ctxEvent.system.length, 0, "no dead-end system push")

  // The native request hook delivers by rewriting the outgoing body.
  const raw = JSON.stringify({ model: "m", system: "base", messages: [{ role: "user", content: "hi" }] })
  const request = new Request("http://example.test/v1/messages", { method: "POST", body: raw })
  const httpEvent = { sessionID: "s1", kind: "primary", request }
  await httpHook(httpEvent)
  const rewritten = await httpEvent.request.clone().text()
  assert.ok(rewritten.includes("[advisor requested"), "directive injected into the body system")
  assert.ok(/<<advisor-plugin:[a-z0-9]+>>/.test(rewritten), "fresh batch marker present")
  assert.ok(rewritten.includes('"model":"m"'), "body shape preserved")

  // Second delivery attempt must not stack (sentinel idempotency).
  const raw2 = JSON.stringify({ model: "m", system: "base", messages: [] })
  const req2 = new Request("http://example.test/v1/messages", { method: "POST", body: raw2 })
  const ev2 = { sessionID: "s1", kind: "primary", request: req2 }
  await httpHook(ev2)
  const out2 = await ev2.request.clone().text()
  assert.equal((out2.match(/<<advisor-plugin:/g) ?? []).length, 0, "nothing pending anymore — request untouched")

  const plain = { sessionID: "s2", prompt: { text: "deploy the cache" } }
  await promptHook(plain)
  assert.equal(plain.prompt.text, "deploy the cache")

  const settings = { sessionID: "s3", prompt: { text: "open advisor settings" } }
  await promptHook(settings)
  const sys = { sessionID: "s3", kind: "primary", model: { providerID: "p", id: "m" }, system: [] }
  await contextHook(sys)
  assert.equal(sys.system.length, 0)
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

  // Queue drains through the native request rewrite, not the dead system channel.
  await captured.contextHooks[0]({ sessionID: "s2", kind: "primary", model: { providerID: "p", id: "m" }, system: [] })
  const request = new Request("http://example.test/v1/messages", { method: "POST", body: JSON.stringify({ system: "s", messages: [] }) })
  const ev = { sessionID: "s2", kind: "primary", request }
  await captured.httpHooks[0](ev)
  const body = await ev.request.clone().text()
  assert.ok(body.includes("[advisor requested"), "directive delivered via native request body")
})

test("/advisor with no focus uses one short line", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const cmd = captured.commands.find((c) => c.name === "advisor")
  await cmd.execute({ sessionID: "s2", prompt: { text: "" }, delivery: "steer" })
  assert.equal(captured.prompts[0].text, "Review the current task with the advisor.")
})

test("RPC set writes the config file, hot-swaps the model; reset restores the deployment default", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const rpc = captured.rpcHandlers.get("opencode-advisor")
  assert.ok(rpc, "rpc registered")

  const before = await rpc.get({})
  assert.equal(before.config.source, "deployment")
  assert.equal(before.config.providerID, "p")

  // Legacy pre-0.7 picker payload → written to the GLOBAL config file.
  const updated = await rpc.set({ providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" })
  assert.equal(updated.config.providerID, "zai-coding-plan")
  assert.equal(updated.config.source, "global")
  const globalFile = join(process.env.XDG_CONFIG_HOME, "opencode", "opencode-advisor.json")
  assert.deepEqual(JSON.parse(await readFile(globalFile, "utf8")), {
    advisor: { providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" },
  })

  // next consult: the sandwich switches the session to the NEW model — no restart
  await captured.tools[0].execute({}, { sessionID: "s9", signal: new AbortController().signal })
  const switched = captured.switchModelCalls.find((c) => c.model.providerID === "zai-coding-plan")
  assert.ok(switched, "new model used for the sub-call")
  assert.equal(switched.model.id, "glm-5.3")
  assert.equal(switched.model.variant, "high")

  // reset clears the file keys → deployment default returns immediately
  const reset = await rpc.reset({})
  assert.equal(reset.config.providerID, "p")
  assert.equal(reset.config.source, "deployment")
  assert.deepEqual(JSON.parse(await readFile(globalFile, "utf8")), {})
  assert.equal(captured.storage.get("advisor:override"), undefined, "the storage override is retired")
})

test("manual config file edits are picked up by the settings RPC without restart", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const rpc = captured.rpcHandlers.get("opencode-advisor")
  const target = join(ctx.location.directory, ".opencode", "opencode-advisor.json")
  await mkdir(join(ctx.location.directory, ".opencode"), { recursive: true })
  await writeFile(target, JSON.stringify({ preset: "thorough" }))

  const out = await rpc.get({})
  assert.equal(out.config.preset, "thorough")
  assert.equal(out.config.maxUsesPerTask, 5, "preset expansion applied from the file")
  assert.equal(out.tiers.preset, "project")
  assert.equal(out.files.project, target, "provenance points at the project file")
})

test("settings RPC validates drafts before touching disk", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const rpc = captured.rpcHandlers.get("opencode-advisor")
  await assert.rejects(() => rpc.set({ doc: { maxUsesPerTask: 999 }, scope: "project" }), /maxUsesPerTask/)
  const entries = await readdir(join(ctx.location.directory, ".opencode")).catch(() => [])
  assert.deepEqual(entries, [], "no file was created for an invalid draft")
})

test("settings RPC: a draft saves to the project file; reset clears known keys only", async () => {
  const { ctx, captured } = makeCtx()
  await createV2Plugin().setup(ctx)
  const rpc = captured.rpcHandlers.get("opencode-advisor")
  const target = join(ctx.location.directory, ".opencode", "opencode-advisor.json")

  const out = await rpc.set({ doc: { preset: "economy", myOwnNote: "keep me" }, scope: "project" })
  assert.equal(out.config.maxUsesPerTask, 1, "economy preset applied immediately")
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { preset: "economy", myOwnNote: "keep me" })

  const reset = await rpc.reset({ scope: "project" })
  assert.equal(reset.config.maxUsesPerTask, 3, "back to defaults")
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { myOwnNote: "keep me" }, "unknown keys survive reset")
})

test("setup migrates a pre-0.7 stored pick into the global file once", async () => {
  const { ctx, captured } = makeCtx()
  captured.storage.set("advisor:override", { providerID: "z", id: "glm-9", variant: "max" })
  await createV2Plugin().setup(ctx)
  assert.equal(captured.storage.get("advisor:override"), undefined, "storage key retired")
  const rpc = captured.rpcHandlers.get("opencode-advisor")
  const out = await rpc.get({})
  assert.equal(out.config.providerID, "z")
  assert.equal(out.config.variant, "max")
  assert.equal(out.config.source, "global", "migrated pick lives in the global file")
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

test("agent mode spawns a read-only child session, polls to idle, returns its advice", async () => {
  const adviceText = "AGENT-GROUNDED-ADVICE: verified in engine.ts line 42."
  let childID = ""
  const { ctx, captured } = makeCtx()
  ctx.options = { advisor: { providerID: "zai-coding-plan", id: "glm-5.3" }, logLevel: "error", advisorMode: "agent", timeoutMs: 20_000 }
  ctx.session.create = async (input) => {
    captured.createInput = input
    childID = "ses_child_agent"
    return { id: childID }
  }
  ctx.session.prompt = async (args) => {
    captured.prompts.push(args)
    return {}
  }
  ctx.session.context = async ({ sessionID }) => {
    if (sessionID === childID) {
      return [{ type: "assistant", content: [{ type: "text", text: adviceText }] }, { type: "idle" }]
    }
    return [{ type: "user", text: "do the thing" }]
  }
  ctx.session.remove = async () => {}
  await createV2Plugin().setup(ctx)

  const result = await captured.tools[0].execute({}, { sessionID: "s-agent", signal: new AbortController().signal })
  assert.ok(result.content.includes("AGENT-GROUNDED-ADVICE"), "child advice returned")
  assert.ok(result.content.startsWith("ADVISOR REVIEW by zai-coding-plan/glm-5.3"), "framed with attribution")

  const create = captured.createInput
  assert.equal(create.agent, "plan", "read-only plan agent")
  assert.equal(create.model.providerID, "zai-coding-plan")
  assert.equal(create.model.id, "glm-5.3")
  const denied = (create.permissions ?? []).filter((p) => p.effect === "deny").map((p) => p.action)
  assert.deepEqual(denied.sort(), ["edit", "shell", "subagent"], "write/shell/subagent denied")

  const childPrompt = captured.prompts.find((p) => p.sessionID === "ses_child_agent")
  assert.ok(childPrompt, "child prompted")
  assert.ok(childPrompt.text.startsWith("You are the ADVISOR operating in AGENT MODE"), "agent prefix present")
  assert.ok(childPrompt.text.includes("<transcript-"), "transcript forwarded for grounding")
})

test("nested advisor sessions are refused (recursion guard)", async () => {
  let childID = "ses_child_nested"
  const { ctx, captured } = makeCtx()
  ctx.options = { advisor: { providerID: "p", id: "a" }, logLevel: "error", advisorMode: "agent", timeoutMs: 20_000 }
  ctx.session.create = async () => ({ id: childID })
  ctx.session.remove = async () => {}
  ctx.session.prompt = async (args) => {
    captured.prompts.push(args)
    // Simulate the child calling the advisor TOOL during its run.
    captured.nestedResult = await captured.tools[0].execute({}, { sessionID: childID, signal: new AbortController().signal })
    return {}
  }
  ctx.session.context = async ({ sessionID }) => {
    if (sessionID === childID) return [{ type: "assistant", content: [{ type: "text", text: "advice" }] }, { type: "idle" }]
    return [{ type: "user", text: "task" }]
  }
  await createV2Plugin().setup(ctx)
  await captured.tools[0].execute({}, { sessionID: "s-root", signal: new AbortController().signal })
  assert.ok(String(captured.nestedResult.content).includes("nested advisor sessions are not supported"), "nested call refused")
})

test("GUARANTEE: the executor receives ONLY the framed advice — never transcript text", async () => {
  const { ctx, captured } = makeCtx()
  const SECRET = "SECRET_TRANSCRIPT_TOKEN_XYZ"
  ctx.session.context = async () => [{ type: "user", text: `${SECRET} long transcript content...` }]
  ctx.session.generate = async () => ({ text: "1. Do A. 2. Then B." })
  await createV2Plugin().setup(ctx)
  const result = await captured.tools[0].execute({}, { sessionID: "s-leak", signal: new AbortController().signal })
  assert.ok(!result.content.includes(SECRET), "no transcript content in the tool result")
  assert.ok(result.content.startsWith("ADVISOR REVIEW by "), "only the framed advice")
  assert.ok(result.content.length < 600, `advice is small (${result.content.length} chars), not a transcript dump`)
})
