import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ADVISOR_CONFIG_KEYS,
  ADVISOR_OVERRIDE_KEY,
  advisorConfigPaths,
  atomicWriteJson,
  loadAdvisorConfig,
  migrateStoredOverride,
  removeAdvisorConfigKeys,
  resolveOptions,
  updateAdvisorConfig,
  writeAdvisorConfig,
} from "../dist/opencode-advisor.js"

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "advisor-config-"))
  return {
    dir,
    home: join(dir, "home"),
    project: join(dir, "project"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function withEnv(env, fn) {
  const prev = {}
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const GLOBAL_REL = join("opencode", "opencode-advisor.json")

test("precedence: deployment < global < project root < project .opencode", async () => {
  const s = await scratch()
  try {
    await withEnv({ XDG_CONFIG_HOME: s.home }, async () => {
      await mkdir(join(s.home, "opencode"), { recursive: true })
      await mkdir(join(s.project, ".opencode"), { recursive: true })
      await writeFile(join(s.home, GLOBAL_REL), JSON.stringify({ maxUsesPerTask: 5, preset: "thorough" }))
      await writeFile(join(s.project, "opencode-advisor.json"), JSON.stringify({ timeoutMs: 40_000 }))
      await writeFile(join(s.project, ".opencode", "opencode-advisor.json"), JSON.stringify({ maxUsesPerTask: 9 }))

      const snap = await loadAdvisorConfig({
        directory: s.project,
        options: { maxUsesPerTask: 3, adviceTokenBudget: 5_000 },
      })
      assert.equal(snap.merged.maxUsesPerTask, 9, "canonical .opencode project file wins")
      assert.equal(snap.merged.timeoutMs, 40_000, "root project file wins over global/options")
      assert.equal(snap.merged.adviceTokenBudget, 5_000, "deployment key survives where files are silent")
      assert.equal(snap.merged.preset, "thorough", "global key survives where project is silent")
      assert.equal(snap.tiers.maxUsesPerTask, "project")
      assert.equal(snap.tiers.timeoutMs, "project")
      assert.equal(snap.tiers.adviceTokenBudget, "deployment")
      assert.equal(snap.tiers.preset, "global")
      assert.equal(snap.files.project, join(s.project, ".opencode", "opencode-advisor.json"))
      assert.deepEqual(snap.files.used, [
        join(s.home, GLOBAL_REL),
        join(s.project, "opencode-advisor.json"),
        join(s.project, ".opencode", "opencode-advisor.json"),
      ])

      const effective = resolveOptions(snap.merged)
      assert.equal(effective.maxUsesPerTask, 9, "explicit project key beats the preset quantity")
      assert.equal(effective.prune.transcriptBudgetChars, 128_000, "thorough (32k tokens) expands to 128k pruner chars")
      assert.equal(effective.adviceTokenBudget, 5_000, "explicit deployment key beats the preset value")
    })
  } finally {
    await s.cleanup()
  }
})

test("invalid or non-object config files fail loudly with the path", async () => {
  const s = await scratch()
  try {
    await withEnv({ XDG_CONFIG_HOME: s.home }, async () => {
      await mkdir(join(s.project, ".opencode"), { recursive: true })
      const file = join(s.project, ".opencode", "opencode-advisor.json")
      await writeFile(file, "{ definitely not json")
      await assert.rejects(
        () => loadAdvisorConfig({ directory: s.project }),
        (err) => {
          assert.match(String(err.message), /invalid JSON/)
          assert.ok(String(err.message).includes(file), "error names the offending file")
          return true
        },
      )
      await writeFile(file, "[1,2,3]")
      await assert.rejects(() => loadAdvisorConfig({ directory: s.project }), /must contain a JSON object/)
    })
  } finally {
    await s.cleanup()
  }
})

test("writeAdvisorConfig merges atomically and leaves no temp files", async () => {
  const s = await scratch()
  try {
    const target = join(s.project, ".opencode", "opencode-advisor.json")
    await writeAdvisorConfig(target, { preset: "balanced" })
    await writeAdvisorConfig(target, { advisor: { providerID: "z", id: "glm" } })
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
      preset: "balanced",
      advisor: { providerID: "z", id: "glm" },
    })
    assert.deepEqual(await readdir(join(s.project, ".opencode")), ["opencode-advisor.json"], "no tmp leftovers")
  } finally {
    await s.cleanup()
  }
})

test("atomicWriteJson replaces documents in place", async () => {
  const s = await scratch()
  try {
    const target = join(s.dir, "x.json")
    await atomicWriteJson(target, { a: 1 })
    await atomicWriteJson(target, { b: 2 })
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { b: 2 })
    assert.deepEqual(await readdir(s.dir), ["x.json"])
  } finally {
    await s.cleanup()
  }
})

test("removeAdvisorConfigKeys clears known keys, preserves unknown ones, no-ops on missing files", async () => {
  const s = await scratch()
  try {
    const target = join(s.dir, "cfg.json")
    await writeFile(target, JSON.stringify({ preset: "economy", myCustom: true }))
    await removeAdvisorConfigKeys(target, ["preset", "advisor", "timeoutMs"])
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { myCustom: true })
    await removeAdvisorConfigKeys(join(s.dir, "missing.json"), ["preset"])
    assert.deepEqual(await readdir(s.dir), ["cfg.json"])
  } finally {
    await s.cleanup()
  }
})

test("updateAdvisorConfig applies set and remove in a single write", async () => {
  const s = await scratch()
  try {
    const target = join(s.dir, "cfg.json")
    await writeFile(target, JSON.stringify({ preset: "economy", advisor: { providerID: "z", id: "g" }, keep: 1 }))
    await updateAdvisorConfig(target, { set: { advisorMode: "agent" }, remove: ["preset"] })
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
      advisor: { providerID: "z", id: "g" },
      keep: 1,
      advisorMode: "agent",
    })
  } finally {
    await s.cleanup()
  }
})

test("migration: a stored pick moves to the global file once", async () => {
  const s = await scratch()
  try {
    await withEnv({ XDG_CONFIG_HOME: s.home }, async () => {
      const globalPath = join(s.home, GLOBAL_REL)
      const storage = new Map([
        [ADVISOR_OVERRIDE_KEY, { providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" }],
      ])
      const logs = []
      const result = await migrateStoredOverride({
        storage: {
          get: async (key) => storage.get(key),
          remove: async (key) => void storage.delete(key),
        },
        globalPath,
        fileSetsAdvisor: false,
        log: (message) => logs.push(message),
      })
      assert.equal(result, "migrated")
      assert.equal(storage.has(ADVISOR_OVERRIDE_KEY), false)
      assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
        advisor: { providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" },
      })
      assert.equal(logs.length, 1)
      const snap = await loadAdvisorConfig({ directory: s.project })
      assert.equal(resolveOptions(snap.merged).advisor.id, "glm-5.3", "the migrated file configures the advisor")
    })
  } finally {
    await s.cleanup()
  }
})

test("migration: a config file that already sets advisor wins; stale key is dropped", async () => {
  const s = await scratch()
  try {
    await withEnv({ XDG_CONFIG_HOME: s.home }, async () => {
      const globalPath = join(s.home, GLOBAL_REL)
      const storage = new Map([[ADVISOR_OVERRIDE_KEY, { providerID: "z", id: "stale" }]])
      const result = await migrateStoredOverride({
        storage: {
          get: async (key) => storage.get(key),
          remove: async (key) => void storage.delete(key),
        },
        globalPath,
        fileSetsAdvisor: true,
      })
      assert.equal(result, "dropped")
      assert.equal(storage.has(ADVISOR_OVERRIDE_KEY), false)
      await assert.rejects(() => readFile(globalPath, "utf8"), "no file was written")
    })
  } finally {
    await s.cleanup()
  }
})

test("migration: none without a stored pick; failed keeps the pick for a retry", async () => {
  const s = await scratch()
  try {
    await withEnv({ XDG_CONFIG_HOME: s.home }, async () => {
      const empty = new Map()
      assert.equal(
        await migrateStoredOverride({
          storage: { get: async (k) => empty.get(k), remove: async (k) => void empty.delete(k) },
          globalPath: join(s.home, GLOBAL_REL),
          fileSetsAdvisor: false,
        }),
        "none",
      )

      const blocker = join(s.dir, "blocker")
      await writeFile(blocker, "not a directory")
      const storage = new Map([[ADVISOR_OVERRIDE_KEY, { providerID: "z", id: "glm" }]])
      const result = await migrateStoredOverride({
        storage: {
          get: async (key) => storage.get(key),
          remove: async (key) => void storage.delete(key),
        },
        globalPath: join(blocker, "opencode-advisor.json"),
        fileSetsAdvisor: false,
      })
      assert.equal(result, "failed")
      assert.equal(storage.has(ADVISOR_OVERRIDE_KEY), true, "pick survives a failed migration")
    })
  } finally {
    await s.cleanup()
  }
})

test("advisorConfigPaths honors XDG_CONFIG_HOME and the project directory", async () => {
  const s = await scratch()
  try {
    await withEnv({ XDG_CONFIG_HOME: s.home }, () => {
      const paths = advisorConfigPaths(s.project)
      assert.equal(paths.global, join(s.home, GLOBAL_REL))
      assert.deepEqual(paths.project, [
        join(s.project, "opencode-advisor.json"),
        join(s.project, ".opencode", "opencode-advisor.json"),
      ])
    })
  } finally {
    await s.cleanup()
  }
})

test("ADVISOR_CONFIG_KEYS carries the token budgets and no retired knobs", () => {
  assert.ok(ADVISOR_CONFIG_KEYS.includes("adviceTokenBudget"))
  assert.ok(ADVISOR_CONFIG_KEYS.includes("transcriptBudgetTokens"))
  assert.ok(!ADVISOR_CONFIG_KEYS.includes("nudge"), "nudge is retired")
  assert.ok(!ADVISOR_CONFIG_KEYS.includes("injectTimingPrompt"), "timing injection is retired")
  assert.ok(!ADVISOR_CONFIG_KEYS.includes("adviceWordBudget"), "word budgets are retired")
  assert.ok(!ADVISOR_CONFIG_KEYS.includes("transcriptBudgetChars"), "char budgets are not user config")
})
