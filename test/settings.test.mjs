import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MODE_DESCRIPTIONS,
  currentLimits,
  currentMode,
  currentModel,
  currentPreset,
  formatDuration,
  formatSize,
  hasChanges,
  limitRows,
  mainMenuRows,
  parseHumanSize,
  presetBlurb,
  presetTitle,
  runSettingsFlow,
  summaryMessage,
  tierLabel,
} from "../dist/opencode-advisor.js"

function makeView(overrides = {}) {
  return {
    config: {
      providerID: "zai-coding-plan",
      id: "glm-5.3",
      variant: "high",
      source: "global",
      preset: "",
      advisorMode: "review",
      maxUsesPerTask: 3,
      maxAttempts: 11,
      timeoutMs: 90_000,
      adviceWordBudget: 120,
      transcriptBudgetChars: 32_000,
      maxToolOutputChars: 1_500,
      triggers: ["advice"],
      logLevel: "info",
      ...(overrides.config ?? {}),
    },
    tiers: { advisor: "global", ...(overrides.tiers ?? {}) },
    files: {
      global: "/home/u/.config/opencode/opencode-advisor.json",
      project: "",
      used: [],
      ...(overrides.files ?? {}),
    },
  }
}

function scripted(options = {}) {
  const view = options.view ?? makeView()
  const selectQueue = [...(options.select ?? [])]
  const promptQueue = [...(options.prompt ?? [])]
  const confirmQueue = [...(options.confirm ?? [])]
  const calls = { saved: [], alerts: [], toasts: [], selects: [], prompts: [], confirms: [] }
  const ports = {
    load: options.load ?? (async () => view),
    save: async (doc) => {
      calls.saved.push(doc)
      if (options.saveError) throw new Error(options.saveError)
      if (options.saveView) return options.saveView(doc, view)
      // Shallow-merge the draft into the view's config — mirrors what the
      // server does for the keys this flow writes.
      return { ...view, config: { ...view.config, ...doc } }
    },
    select: async (request) => {
      calls.selects.push(request)
      return selectQueue.shift()
    },
    alert: async (optionsIn) => {
      calls.alerts.push(optionsIn)
    },
    confirm: async (optionsIn) => {
      calls.confirms.push(optionsIn)
      return confirmQueue.shift()
    },
    prompt: async (optionsIn) => {
      calls.prompts.push(optionsIn)
      return promptQueue.shift()
    },
    toast: (message, variant) => {
      calls.toasts.push({ message, variant })
    },
    models: async () => options.models ?? [],
  }
  return { ports, calls }
}

/* ------------------------------ preset table ------------------------------ */

test("preset table is exactly the documented quantities (single source: PRESETS)", () => {
  const expected = {
    economy: "1 consult/task · 16K context · 80-word advice",
    balanced: "3 consults/task · 32K context · 120-word advice",
    thorough: "5 consults/task · 128K context · 200-word advice",
    exhaustive: "8 consults/task · 500K context · 300-word advice",
  }
  for (const [name, blurb] of Object.entries(expected)) assert.equal(presetBlurb(name), blurb, name)
  assert.equal(presetTitle("balanced"), "Balanced (recommended)")
  assert.equal(presetTitle("thorough"), "Thorough")
})

test("formatting: sizes, durations, human input", () => {
  assert.equal(formatSize(32_000), "32K")
  assert.equal(formatSize(1_500), "1.5K")
  assert.equal(formatSize(500_000), "500K")
  assert.equal(formatSize(1_000_000), "1M")
  assert.equal(formatSize(500), "500")
  assert.equal(formatDuration(90_000), "90s")
  assert.equal(formatDuration(120_000), "2 min")
  assert.equal(formatDuration(300_000), "5 min")
  assert.equal(parseHumanSize("128k"), 128_000)
  assert.equal(parseHumanSize("1.5m"), 1_500_000)
  assert.equal(parseHumanSize("64000"), 64_000)
  assert.equal(parseHumanSize("nope"), undefined)
})

test("display state and menu rows reflect the effective view + draft", () => {
  // The server returns PRESET-RESOLVED values: thorough ⇒ 5 / 128K / 200.
  const view = makeView({
    config: { preset: "thorough", maxUsesPerTask: 5, transcriptBudgetChars: 128_000, adviceWordBudget: 200 },
  })
  const model = currentModel(view, {})
  assert.equal(model.label, "glm-5.3 · high")
  assert.equal(model.description.includes("global file"), true)

  const preset = currentPreset(view, {})
  assert.equal(preset.name, "thorough")
  assert.equal(preset.isDefault, false)

  const rows = mainMenuRows(view, {})
  assert.ok(rows.find((r) => r.value === "preset").title.includes("Thorough"))
  assert.ok(rows.find((r) => r.value === "limits").title.includes("5 consults/task"))

  // Draft overrides win; null means inherit.
  const rowsDraft = mainMenuRows(view, { preset: null, maxUsesPerTask: 2 })
  assert.ok(rowsDraft.find((r) => r.value === "preset").title.includes("Inherit"))
  assert.ok(rowsDraft.find((r) => r.value === "limits").title.includes("2 consults/task"))
  assert.equal(hasChanges({}), false)
  assert.equal(tierLabel("project"), "project file")
  assert.equal(tierLabel(undefined), "default")

  assert.equal(currentLimits(view, {}).consults, 5, "limits follow the preset-resolved effective view")
  assert.equal(currentMode(view, {}).mode, "review")
  assert.equal(limitRows(view, {}).length, 7)
  assert.ok(summaryMessage(makeView()).includes("Applies immediately"))
})

/* ---------------------------------- flow ---------------------------------- */

test("flow: pick a preset and Save writes exactly the preset key", async () => {
  const { ports, calls } = scripted({ select: ["preset", "thorough", "save"] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ preset: "thorough" }])
  assert.equal(calls.prompts.length, 0)
  assert.equal(calls.alerts.length, 1)
  assert.ok(calls.alerts[0].title.includes("Saved"))
  assert.ok(calls.alerts[0].message.includes("Thorough"))
})

test("flow: nothing is written until Save, and Cancel writes nothing", async () => {
  const { ports, calls } = scripted({ select: ["cancel"] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [])
  assert.equal(calls.confirms.length, 0, "no discard prompt when nothing changed")
  assert.equal(calls.alerts.length, 0)
})

test("flow: Esc with a dirty draft asks before discarding", async () => {
  const { ports, calls } = scripted({
    select: ["mode", "agent", "cancel", "cancel"],
    confirm: [false, true],
  })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [])
  assert.equal(calls.confirms.length, 2, "keep-editing then discard")
  assert.ok(calls.selects.length >= 3)
})

test("flow: limits are edited through the submenu and saved as explicit keys", async () => {
  const { ports, calls } = scripted({ select: ["limits", "consults", "5", "back", "save"] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ maxUsesPerTask: 5 }])
  assert.ok(calls.selects[0].title.includes("Advisor Settings"))
})

test("flow: Inherit removes a key instead of freezing a value", async () => {
  const { ports, calls } = scripted({ select: ["preset", "__inherit__", "save"] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ preset: null }])
})

test("flow: custom limit values are validated via the prompt dialog", async () => {
  const bad = scripted({ select: ["limits", "context", "__custom__", "back", "save"], prompt: ["abc"] })
  await runSettingsFlow(bad.ports)
  assert.equal(bad.calls.alerts.length, 1)
  assert.ok(bad.calls.alerts[0].title.includes("Invalid"))

  const good = scripted({ select: ["limits", "context", "__custom__", "back", "save"], prompt: ["128k"] })
  await runSettingsFlow(good.ports)
  assert.deepEqual(good.calls.saved, [{ transcriptBudgetChars: 128_000 }])
})

test("flow: model picker uses the live catalog and keeps preset keys untouched", async () => {
  const models = [{ providerID: "opencode-go", id: "kimi-k2", name: "Kimi K2", variants: ["max"] }]
  const { ports, calls } = scripted({
    models,
    select: ["model", "opencode-go/kimi-k2", "max", "save"],
  })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ advisor: { providerID: "opencode-go", id: "kimi-k2", variant: "max" } }])
})

test("flow: custom model entry accepts providerID/modelID", async () => {
  const { ports, calls } = scripted({
    select: ["model", "__custom__", "save"],
    prompt: ["custom-prov/model-x"],
  })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ advisor: { providerID: "custom-prov", id: "model-x" } }])
})

test("flow: reset writes null for every known key after confirmation", async () => {
  const { ports, calls } = scripted({ select: ["reset"], confirm: [true] })
  await runSettingsFlow(ports)
  assert.equal(calls.saved.length, 1)
  assert.equal(calls.saved[0].advisor, null)
  assert.equal(calls.saved[0].preset, null)
  assert.equal(calls.saved[0].maxUsesPerTask, null)
  assert.ok(calls.alerts[0].title.includes("Reset"))
})

test("flow: save with no changes is a no-op; save failures surface loudly", async () => {
  const idle = scripted({ select: ["save", "cancel"] })
  await runSettingsFlow(idle.ports)
  assert.deepEqual(idle.calls.saved, [])
  assert.ok(idle.calls.toasts.some((t) => t.message.includes("No changes")))

  const failing = scripted({
    select: ["preset", "economy", "save", "cancel"],
    confirm: [true],
    saveError: "disk on fire",
  })
  await runSettingsFlow(failing.ports)
  assert.equal(failing.calls.saved.length, 1, "attempted")
  assert.ok(failing.calls.toasts.some((t) => t.variant === "error" && t.message.includes("disk on fire")))
  assert.equal(failing.calls.alerts.length, 0, "no success screen on failure")
})

test("flow: an unreadable config shows an error toast and exits", async () => {
  const { ports, calls } = scripted({
    load: async () => {
      throw new Error("config file is invalid JSON")
    },
  })
  await runSettingsFlow(ports)
  assert.equal(calls.selects.length, 0)
  assert.ok(calls.toasts.some((t) => t.variant === "error" && t.message.includes("invalid JSON")))
})

test("mode choices document both mechanisms", () => {
  assert.ok(MODE_DESCRIPTIONS.review.includes("Fast"))
  assert.ok(MODE_DESCRIPTIONS.agent.includes("verifies"))
})
