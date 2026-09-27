import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MODE_DESCRIPTIONS,
  PRESETS,
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
  tierLabel, limitPage, MENU_ROW_BUDGET, MENU_VIEWPORT_ROWS, projectView, resolveOptions,} from "../dist/opencode-advisor.js"

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
      advisorResponseWaitMs: 90_000,
      maxConsultMs: 3_600_000,
      adviceTokenBudget: 8_000,
      transcriptBudgetTokens: 32_000,
      maxToolOutputTokens: 750,
      pruning: "standard",
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
      // Faithful merge: a preset expands to its quantities (as resolveOptions
      // does), then explicit draft keys override — so the post-save view is
      // exactly what the server would return.
      const config = { ...view.config }
      if (typeof doc.preset === "string" && PRESETS[doc.preset]) {
        const preset = PRESETS[doc.preset]
        config.maxUsesPerTask = preset.maxUsesPerTask
        config.transcriptBudgetTokens =
          typeof preset.transcriptBudgetTokens === "string" ? parseHumanSize(preset.transcriptBudgetTokens) : preset.transcriptBudgetTokens
        config.adviceTokenBudget = preset.adviceTokenBudget
      }
      for (const [key, value] of Object.entries(doc)) {
        if (value === null) continue // "inherit" — cannot resolve other layers here
        config[key] = value
      }
      return { ...view, config }
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
    economy: "1 consult/task · 16K context tokens · 4K advice tokens",
    balanced: "3 consults/task · 32K context tokens · 8K advice tokens",
    thorough: "5 consults/task · 64K context tokens · 16K advice tokens",
    exhaustive: "8 consults/task · 128K context tokens · 32K advice tokens",
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
  // The server returns PRESET-RESOLVED values: thorough ⇒ 5 / 32K / 16K.
  const view = makeView({
    config: { preset: "thorough", maxUsesPerTask: 5, transcriptBudgetTokens: 64_000, adviceTokenBudget: 16_000 },
  })
  const model = currentModel(view, {})
  assert.equal(model.label, "glm-5.3 · high")
  assert.equal(model.description.includes("global file"), true)

  const preset = currentPreset(view, {})
  assert.equal(preset.name, "thorough")
  assert.equal(preset.isDefault, false)

  // ONE level: model, preset, evidence basis and Advanced are all on the
  // settings page. An extra "Settings" row you had to open before seeing any
  // of them was pure indirection.
  const rows = mainMenuRows(view, {})
  assert.deepEqual(
    rows.map((r) => r.value),
    ["model", "preset", "mode", "advanced", "save", "reset", "cancel"],
    "the settings page is one flat list; Advanced is the only submenu",
  )
  assert.ok(!rows.some((r) => r.value === "settings"), "no intermediate Settings row")
  assert.ok(rows.find((r) => r.value === "preset").title.includes("Thorough"))
  assert.ok(rows.find((r) => r.value === "advanced").title.includes("5 consults"))
  assert.ok(
    rows.find((r) => r.value === "advanced").description.includes("64K context, 16K advice"),
    "the Advanced row summarises the budgets in tokens",
  )
  assert.equal(
    rows.filter((r) => r.category === "Settings").length,
    3,
    "model, preset and evidence basis are grouped under Settings",
  )

  // Draft overrides win; null means inherit.
  const rowsDraft = mainMenuRows(view, { preset: null, maxUsesPerTask: 2 })
  assert.ok(rowsDraft.find((r) => r.value === "preset").title.includes("Inherit"))
  assert.ok(rowsDraft.find((r) => r.value === "advanced").title.includes("2 consults"))
  assert.equal(hasChanges({}), false)
  assert.equal(tierLabel("project"), "project file")
  assert.equal(tierLabel(undefined), "default")

  assert.equal(currentLimits(view, {}).consults, 5, "limits follow the preset-resolved effective view")
  assert.equal(currentLimits(view, {}).contextTokens, 64_000)
  assert.equal(currentLimits(view, {}).adviceTokens, 16_000)
  assert.equal(currentLimits(view, {}).toolCap, 750, "per-tool cap is a token budget")
  assert.equal(currentLimits(view, {}).pruning, "standard")
  assert.equal(currentMode(view, {}).mode, "review")
  assert.equal(
    limitRows(view, {}).length,
    8,
    "page 1 fits the viewport: consults, context, advice, wait, maxTime, pruning, more, back",
  )
  assert.ok(
    limitRows(view, {}).some((r) => r.value === "maxTime" && r.title.includes("Max consult time")),
    "max consult time is reachable from the menu",
  )
  assert.ok(
    limitRows(view, {}).some((r) => r.value === "pruning" && r.title.includes("Pruning — standard")),
    "the pruning policy is editable, not JSON-only",
  )
  assert.ok(limitRows(view, {}).some((r) => r.value === "wait" && r.title.includes("Response wait — 90s")))
  assert.ok(limitRows(view, {}).some((r) => r.value === "maxTime" && r.title.includes("Max consult time — 1h")))
  assert.ok(limitRows(view, {}).some((r) => r.value === "advice" && r.title.includes("16K tokens")))
  assert.ok(
    mainMenuRows(view, {}).some((r) => r.value === "mode" && r.title.startsWith("Evidence basis —")),
    "Mode is renamed to say what it changes about the answer",
  )
  // The row states the consequence, not just the name: "none" is a real mode.
  const noneView = makeView({ config: { ...makeView().config, pruning: "none" } })
  assert.ok(
    limitRows(noneView, {}).some((r) => r.value === "pruning" && r.title.includes("none (verbatim)")),
    "pruning:none is visible and labelled",
  )
  assert.ok(
    limitPage(view, {}, "more").some((r) => r.value === "toolcap" && r.title.includes("750 tokens")),
    "per-tool cap speaks tokens, not characters (it lives on page 2)",
  )
  assert.ok(summaryMessage(makeView()).includes("Applies immediately"))
})

test("preset display: matching values report the preset; deviations compute Custom", () => {
  // (c) file-attributed values matching a preset exactly → that preset
  const explicit = makeView({
    config: { preset: "", maxUsesPerTask: 5, transcriptBudgetTokens: 64_000, adviceTokenBudget: 16_000 },
    tiers: { maxUsesPerTask: "project", transcriptBudgetTokens: "project", adviceTokenBudget: "project" },
  })
  const matched = currentPreset(explicit, {})
  assert.equal(matched.kind, "preset")
  assert.equal(matched.name, "thorough")

  // A pristine balanced view is the default preset.
  const balanced = currentPreset(makeView(), {})
  assert.equal(balanced.kind, "preset")
  assert.equal(balanced.name, "balanced")
  assert.equal(balanced.isDefault, true)

  // (a) a file-attributed context budget matching no preset → Custom
  const deviated = makeView({
    config: { transcriptBudgetTokens: 12_000 },
    tiers: { transcriptBudgetTokens: "project" },
  })
  const custom = currentPreset(deviated, {})
  assert.equal(custom.kind, "custom")
  assert.equal(custom.title, "Custom")

  // (b) a draft deviation from the balanced base → Custom too
  assert.equal(currentPreset(makeView(), { adviceTokenBudget: 4_000 }).kind, "custom")

  // Inherit still wins over both computed states.
  assert.equal(currentPreset(makeView(), { preset: null }).kind, "inherit")
})

/* ---------------------------------- flow ---------------------------------- */

test("flow: pick a preset and Save writes exactly the preset key", async () => {
  const { ports, calls } = scripted({ select: ["preset", "thorough", "save"] , confirm: [true] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ preset: "thorough" }])
  assert.equal(calls.prompts.length, 0)
  // Save is preview-then-Confirm, not a receipt: the confirm carries the
  // summary and nothing is written until it is accepted.
  assert.equal(calls.confirms.length, 1)
  assert.equal(calls.confirms[0].confirmLabel, "Save")
  assert.ok(calls.confirms[0].message.includes("Thorough"), "the preview names the new preset")
  assert.equal(calls.alerts.length, 0, "no blocking dialog after the preview")
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
  const { ports, calls } = scripted({ select: ["limits", "consults", "5", "back", "save"] , confirm: [true] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ maxUsesPerTask: 5 }])
  assert.ok(calls.selects[0].title.includes("Advisor Settings"))
})

test("flow: Inherit removes a key instead of freezing a value", async () => {
  const { ports, calls } = scripted({ select: ["preset", "__inherit__", "save"] , confirm: [true] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ preset: null }])
})

test("flow: custom limit values are validated via the prompt dialog", async () => {
  const bad = scripted({ select: ["limits", "context", "__custom__", "back", "save"], prompt: ["abc"] , confirm: [true] })
  await runSettingsFlow(bad.ports)
  assert.equal(bad.calls.alerts.length, 1)
  assert.ok(bad.calls.alerts[0].title.includes("Invalid"))

  const good = scripted({ select: ["limits", "context", "__custom__", "back", "save"], prompt: ["128k"] , confirm: [true] })
  await runSettingsFlow(good.ports)
  assert.deepEqual(good.calls.saved, [{ transcriptBudgetTokens: 128_000 }])
})

test("flow: context and advice pickers offer the token presets through the draft keys", async () => {
  const { ports, calls } = scripted({ select: ["limits", "context", "32000", "advice", "16000", "back", "save"] , confirm: [true] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ transcriptBudgetTokens: 32_000, adviceTokenBudget: 16_000 }])

  const contextPicker = calls.selects.find((s) => s.title === "Context budget")
  assert.deepEqual(
    contextPicker.options.filter((o) => /^\d+$/.test(o.value)).map((o) => Number(o.value)),
    [16_000, 32_000, 64_000, 128_000, 256_000, 1_000_000],
    "context choices stop at the measured peak, with one oversize escape",
  )
  const advicePicker = calls.selects.find((s) => s.title === "Advice length")
  assert.deepEqual(
    advicePicker.options.filter((o) => /^\d+$/.test(o.value)).map((o) => Number(o.value)),
    [4_000, 8_000, 16_000, 32_000, 64_000],
    "advice choices stop near the overthinking threshold",
  )
})

test("flow: model picker uses the live catalog and keeps preset keys untouched", async () => {
  const models = [{ providerID: "opencode-go", id: "kimi-k2", name: "Kimi K2", variants: ["max"] }]
  const { ports, calls } = scripted({
    models,
    select: ["model", "opencode-go/kimi-k2", "max", "save"], confirm: [true] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ advisor: { providerID: "opencode-go", id: "kimi-k2", variant: "max" } }])
})

test("flow: custom model entry accepts providerID/modelID", async () => {
  const { ports, calls } = scripted({
    select: ["model", "__custom__", "save"],
    prompt: ["custom-prov/model-x"], confirm: [true] })
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
  const idle = scripted({ select: ["save", "cancel"] , confirm: [true] })
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
  assert.ok(MODE_DESCRIPTIONS.agent.startsWith("Review + Agent —"), "agent mode is labelled Review + Agent")
  assert.ok(MODE_DESCRIPTIONS.agent.includes("verifies"))
})

test("flow: the pruning picker writes pruning:none and supports Inherit", async () => {
  const none = scripted({ select: ["limits", "pruning", "none", "back", "save"] , confirm: [true] })
  await runSettingsFlow(none.ports)
  assert.deepEqual(none.calls.saved, [{ pruning: "none" }], "verbatim mode is saved under its own key")

  const inherit = scripted({ select: ["limits", "pruning", "__inherit__", "back", "save"] , confirm: [true] })
  await runSettingsFlow(inherit.ports)
  assert.deepEqual(inherit.calls.saved, [{ pruning: null }], "Inherit removes the key rather than freezing a value")

  const picker = none.calls.selects.find((s) => s.title === "Pruning")
  assert.ok(
    picker.options.some((o) => o.value === "none" && o.description.includes("context window")),
    "the picker explains the trade, not just the label",
  )
})

/* ═══ reachability: no row may be a dead button ═══ */

/** Menu titles the flow rendered, in order. */
function titles(calls) {
  return calls.selects.map((s) => s.title)
}

test("every settings-page row is reachable, and Advanced opens the limits", async () => {
  const { ports, calls } = scripted({ select: ["advanced", "maxTime", "10800000", "back", "save"] , confirm: [true] })
  await runSettingsFlow(ports)
  const t = titles(calls)
  assert.ok(t[0].startsWith("Advisor Settings"), `the settings page renders (${JSON.stringify(t)})`)
  assert.ok(t[1] === "Limits", `"advanced" opens the limits menu (${JSON.stringify(t)})`)
  assert.ok(t[2] === "Max consult time", "the ceiling row opens its picker")
  assert.deepEqual(calls.saved, [{ maxConsultMs: 10_800_000 }], "and the edit saves under the real key")
  assert.ok(!calls.toasts.some((x) => x.variant === "error"), `no unknown-row errors (${JSON.stringify(calls.toasts)})`)
})

test("every row on the settings page opens something", async () => {
  // The settings page has no "back" row, so a leaf row goes straight to Save;
  // only a submenu has to be closed first.
  for (const row of mainMenuRows(makeView(), {})) {
    if (row.value === "cancel" || row.value === "save" || row.value === "reset") continue
    const script = row.value === "advanced" ? ["advanced", "back", "save"] : [row.value, "__inherit__", "save"]
    const { ports, calls } = scripted({ select: script })
    await runSettingsFlow(ports)
    assert.ok(
      !calls.toasts.some((x) => x.variant === "error" && /Unknown|no config key/.test(x.message)),
      `settings row "${row.value}" is unhandled (${JSON.stringify(calls.toasts)})`,
    )
    // The row must lead SOMEWHERE: the very next render has to differ. A row
    // with no handler redraws the identical list, which is the dead button.
    // (Comparing later pairs is wrong — re-rendering the page after a save is
    // correct behaviour, not a stall.)
    const t = titles(calls)
    assert.ok(t.length > 1, `"${row.value}" produced no further interaction`)
    assert.notEqual(t[1], t[0], `"${row.value}" is a dead button: ${JSON.stringify(t)}`)
  }
})

/* ═══ "if I change anything, the preset becomes Custom" ═══ */

test("every limit row on BOTH pages opens something — none is a dead button", async () => {
  // A row with no handler redraws the SAME list, which the user sees as a dead
  // button. This bug shipped twice (an unhandled "Settings" row, then an
  // unhandled "maxTime" row), so every row is now exercised explicitly — on
  // page 1 AND behind "More limits…", because paging must not drop a limit.
  const pick = {
    consults: "7", wait: "1800000", maxTime: "10800000", context: "64000",
    advice: "16000", pruning: "none", toolcap: "2000", retries: "42", loglevel: "debug",
  }
  for (const [page, rows] of [
    ["p1", limitPage(makeView(), {}, "primary")],
    ["p2", limitPage(makeView(), {}, "more")],
  ]) {
    // Reach the page, take the row, answer its picker, then unwind one "back"
    // per menu level before saving so the flow always terminates.
    const enter = page === "p2" ? ["advanced", "more"] : ["advanced"]
    const leave = page === "p2" ? ["back", "back"] : ["back"]
    for (const row of rows) {
      if (row.value === "back" || row.value === "more") continue
      const { ports, calls } = scripted({ select: [...enter, row.value, pick[row.value] ?? "standard", ...leave, "save"] , confirm: [true] })
      await runSettingsFlow(ports)
      assert.ok(
        !calls.toasts.some((x) => x.variant === "error" && /Unknown|no config key/.test(x.message)),
        `limits row "${row.value}" (${page}) is unhandled (${JSON.stringify(calls.toasts)})`,
      )
      const t = calls.selects.map((x) => x.title)
      for (let k = 2; k < t.length; k++) {
        assert.ok(!(t[k] === "Limits" && t[k - 1] === "Limits"), `"${row.value}" redrew the list in place: ${JSON.stringify(t)}`)
      }
    }
  }
})

test("each limit row writes to its OWN config key — no cross-wiring", async () => {
  // The defect this locks: the ceiling picker wrote `maxAttempts`, because the
  // key was derived from the row name by a ternary chain that was not updated
  // when the row was renamed ceiling -> maxTime. Setting max consult time
  // silently destroyed the retry ceiling. Each key is now co-located with its
  // own picker, and this proves the mapping end to end.
  const cases = [
    ["consults", "maxUsesPerTask", "7"],
    ["wait", "advisorResponseWaitMs", "1800000"],
    ["maxTime", "maxConsultMs", "10800000"],
    ["context", "transcriptBudgetTokens", "64000"],
    ["advice", "adviceTokenBudget", "16000"],
    ["toolcap", "maxToolOutputTokens", "2000"],
    ["retries", "maxAttempts", "42"],
  ]
  for (const [row, key, value] of cases) {
    const { ports, calls } = scripted({ select: ["advanced", row, value, "back", "save"] , confirm: [true] })
    await runSettingsFlow(ports)
    assert.deepEqual(calls.saved, [{ [key]: Number(value) }], `row "${row}" must write only ${key}`)
  }
})

test("the categorical limits save their own keys too", async () => {
  const pruning = scripted({ select: ["advanced", "pruning", "none", "back", "save"] , confirm: [true] })
  await runSettingsFlow(pruning.ports)
  assert.deepEqual(pruning.calls.saved, [{ pruning: "none" }], "pruning saves under `pruning`")

  const log = scripted({ select: ["advanced", "loglevel", "debug", "back", "save"] , confirm: [true] })
  await runSettingsFlow(log.ports)
  assert.deepEqual(log.calls.saved, [{ logLevel: "debug" }], "log level saves under `logLevel`")
})

/* ═══ "if I change anything, the preset becomes Custom" ═══ */


test("ANY edit flips the preset to Custom — including the wait and the ceiling", () => {
  const view = makeView({ config: { preset: "balanced" } })
  assert.equal(currentPreset(view, {}).name, "balanced", "untouched: the declared preset")
  const edits = [
    { transcriptBudgetTokens: 64_000 }, { adviceTokenBudget: 16_000 }, { maxUsesPerTask: 7 },
    { advisorResponseWaitMs: 180_000 }, { maxConsultMs: 7_200_000 },
    { maxToolOutputTokens: 2_000 }, { pruning: "none" }, { maxAttempts: 20 },
    { logLevel: "debug" }, { advisorMode: "agent" }, { advisor: { providerID: "z", id: "q" } },
  ]
  for (const draft of edits) {
    const p = currentPreset(view, draft)
    assert.equal(p.kind, "custom", `${JSON.stringify(draft)} must report Custom (got ${p.kind})`)
    assert.equal(p.title, "Custom")
    assert.ok(p.blurb.includes("You have changed a setting"), "the blurb explains WHY it says Custom")
  }
})

test("picking a preset again still names that preset when nothing else is edited", () => {
  const view = makeView({ config: { preset: "balanced" } })
  assert.equal(currentPreset(view, { preset: "thorough" }).name, "thorough")
  // A non-preset edit survives re-picking a preset, so Custom is the honest label.
  assert.equal(currentPreset(view, { maxConsultMs: 7_200_000, preset: "thorough" }).kind, "custom")
  // Inherit still wins over everything.
  assert.equal(currentPreset(view, { preset: null }).kind, "inherit")
})

test("the GUI reflects the change immediately: the preset row flips to Custom", async () => {
  // No save here — we only care what the ROWS said along the way — so the
  // discard prompt must be answered or the flow re-asks forever.
  const { ports, calls } = scripted({
    select: ["advanced", "context", "64000", "back"],
    confirm: [true],
  })
  await runSettingsFlow(ports)
  const presetTitles = calls.selects
    .flatMap((s) => s.options)
    .filter((o) => o.value === "preset")
    .map((o) => o.title)
  assert.ok(presetTitles.some((t) => t.includes("Balanced")), `started as the preset (${JSON.stringify(presetTitles)})`)
  assert.ok(presetTitles.some((t) => t.includes("Custom")), `the row updated to Custom (${JSON.stringify(presetTitles)})`)
  assert.ok(
    presetTitles.findIndex((t) => t.includes("Custom")) > presetTitles.findIndex((t) => t.includes("Balanced")),
    "Custom appears AFTER the edit, not before",
  )
})

/* ═══ the post-save preview must mirror the settings page ═══ */

test("the preview covers EVERY setting the menu can change", () => {
  // The audit that was missing: five advanced limits were absent from the
  // preview, so the confirmation the user reads after saving described less
  // than the menu they just used. Coverage is now asserted, not eyeballed.
  const out = summaryMessage(makeView())
  const must = [
    ["advisor model", "m"],                     // the fixture's model label
    ["consults per task", "3"],
    ["context budget", "32K tokens"],
    ["advice length", "8K tokens"],
    ["per-tool output", "750 tokens"],
    ["response wait", "90s"],
    ["max consult time", "1h"],
    ["pruning", "standard"],
    ["retry ceiling", "11"],
    ["log level", "info"],
    ["saved to", "/home/u/.config/opencode/opencode-advisor.json"],
    ["applies immediately", "no restart"],
  ]
  for (const [label, value] of must) {
    const line = out.split("\n").find((l) => l.trim().toLowerCase().startsWith(label))
    assert.ok(line, `the preview is missing a "${label}" row:\n${out}`)
    assert.ok(line.includes(value), `"${label}" should show ${value}, got: ${line}`)
  }
  // The evidence basis must appear under its CURRENT name, not the old one.
  assert.ok(out.includes("Evidence basis"), "uses the current row name")
  assert.ok(!/^\s*Mode\s/m.test(out), "the stale 'Mode' label is gone")
})

test("the preview is grouped like the menu: Settings, then Advanced by section", () => {
  const out = summaryMessage(makeView())
  const order = ["SETTINGS", "ADVANCED · BUDGETS", "ADVANCED · TIMING", "ADVANCED · EVIDENCE"]
  const at = order.map((h) => out.indexOf(h))
  assert.ok(at.every((i) => i >= 0), `every section is present:\n${out}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, `sections appear in menu order:\n${out}`)
  // The limits pages carry NO category headers — each one costs a viewport
  // line — so the group is named in each row's description instead.
  assert.ok(limitRows(makeView(), {}).every((r) => !r.category), "no headers on the limits pages")
  assert.ok(out.includes("none (verbatim)") === false, "standard pruning is not labelled verbatim")
  const verbatim = summaryMessage(makeView({ config: { pruning: "none" } }))
  assert.ok(verbatim.includes("none (verbatim)"), "verbatim pruning says so")
})

test("the preview has no padded headers or doubled mode names", () => {
  for (const view of [makeView(), makeView({ config: { advisorMode: "agent", pruning: "none" } })]) {
    for (const line of summaryMessage(view).split("\n")) {
      assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`)
    }
    assert.ok(
      !/Review \+ Agent — Review \+ Agent/.test(summaryMessage(view)),
      "the evidence-basis description must not repeat the title",
    )
  }
})

test("columns align across the whole preview", () => {
  const lines = summaryMessage(makeView()).split("\n")
  // A data row is "  <label><2+ spaces><value>"; the value column must be the
  // same offset on every one of them, or the block reads as ragged.
  const valueColumn = lines
    .map((l) => /^ {2}(.+?) {2,}(\S.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[0].length - m[2].length)
  assert.ok(valueColumn.length >= 8, `there are enough data rows to align (${valueColumn.length})`)
  assert.equal(new Set(valueColumn).size, 1, `all values start at one column: ${JSON.stringify(valueColumn)}`)
})

/* ═══ responsive: every menu must fit the host viewport ═══ */

/** Visual lines a menu occupies: its rows plus one header per group. */
function visualLines(rows) {
  const groups = new Set(rows.map((r) => r.category || "")).size
  return rows.length + Math.max(0, groups - (rows.some((r) => !r.category) ? 1 : 0))
}

test("no menu overflows the host's 10-row select viewport", () => {
  // OpenCode's select dialog has a hardcoded 10-row viewport, and renders each
  // row's `category` as its own line. A menu that exceeds it scrolls, so the
  // row the user wants can be off-screen before they have read the list. This
  // is the responsiveness invariant: rows + group headers must fit.
  const menus = {
    "settings page": mainMenuRows(makeView(), {}),
    "limits p1": limitPage(makeView(), {}, "primary"),
    "limits p2": limitPage(makeView(), {}, "more"),
  }
  for (const [name, rows] of Object.entries(menus)) {
    const lines = visualLines(rows)
    assert.ok(lines <= MENU_VIEWPORT_ROWS, `${name} needs ${lines} lines, viewport is ${MENU_VIEWPORT_ROWS}`)
    assert.ok(rows.length <= MENU_ROW_BUDGET, `${name} has ${rows.length} rows, budget is ${MENU_ROW_BUDGET}`)
  }
})

test("the limits page fits by paging, never by hiding a limit", () => {
  // Every limit must be reachable from SOME page: paging changes where a row
  // lives, not whether it exists.
  const reachable = new Set([...limitPage(makeView(), {}, "primary"), ...limitPage(makeView(), {}, "more")].map((r) => r.value))
  for (const key of [
    "consults", "wait", "maxTime", "context", "advice", "toolcap", "pruning", "retries", "loglevel", "back",
  ]) {
    assert.ok(reachable.has(key), `"${key}" is unreachable — paging must not drop a limit`)
  }
  // The overflow row advertises what it hides, so nothing is a mystery.
  const more = limitPage(makeView(), {}, "primary").find((r) => r.value === "more")
  assert.ok(more.description.includes("retries") && more.description.includes("log"), `the More row previews its contents: ${more.description}`)
})

test("paging works end-to-end and both pages share one key mapping", async () => {
  const { ports, calls } = scripted({ select: ["advanced", "more", "retries", "42", "back", "back", "save"] , confirm: [true] })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ maxAttempts: 42 }], "a limit on page 2 writes its own key")
  const titles = calls.selects.map((s) => s.title)
  assert.ok(titles.includes("More limits"), `page 2 is titled distinctly (${JSON.stringify(titles)})`)
  assert.ok(
    titles.lastIndexOf("Limits") > titles.indexOf("More limits"),
    `back from page 2 returns to page 1 (${JSON.stringify(titles)})`,
  )
  assert.ok(!calls.toasts.some((x) => x.variant === "error"), "no unknown-row errors")
})

test("page 1 still names each limit's group in its description", () => {
  // The headers are gone to save viewport lines, so the group has to survive in
  // the text. Page 2 is the ungrouped overflow and is exempt.
  for (const row of limitPage(makeView(), {}, "primary")) {
    if (row.value === "back" || row.value === "more") continue
    assert.ok(
      /Budgets|Timing|Evidence/.test(row.description),
      `"${row.value}" lost its group when the headers were dropped: ${row.description}`,
    )
  }
})

/* ═══ Save All: preview first, write only on Confirm ═══ */

test("Save All previews BEFORE writing, and Confirm is what commits", async () => {
  const order = []
  const { ports, calls } = scripted({ select: ["advanced", "maxTime", "10800000", "back", "save"], confirm: [true] })
  const inner = ports.save
  ports.save = async (d) => { order.push("save"); return inner(d) }
  const realConfirm = ports.confirm
  ports.confirm = async (o) => { order.push("confirm"); ports.preview = o.message; return realConfirm(o) }
  await runSettingsFlow(ports)
  assert.deepEqual(order, ["confirm", "save"], `the preview comes first (${JSON.stringify(order)})`)
  assert.deepEqual(calls.saved, [{ maxConsultMs: 10_800_000 }], "Confirm wrote exactly the draft")
  assert.equal(ports.preview.includes("Max consult time"), true, "the preview shows the value being saved")
  assert.equal(ports.preview.includes("3h"), true, `…at its NEW value, not the old one:\n${ports.preview}`)
})

test("declining the preview writes nothing and keeps the draft", async () => {
  const { ports, calls } = scripted({
    select: ["advanced", "maxTime", "10800000", "back", "save", "save"],
    confirm: [false, true],
  })
  await runSettingsFlow(ports)
  assert.deepEqual(calls.saved, [{ maxConsultMs: 10_800_000 }], "only the CONFIRMED save wrote")
  const declined = calls.confirms[0]
  assert.equal(declined.confirmLabel, "Save", "the dialog's confirm button is the save")
  assert.equal(declined.cancelLabel, "Keep editing", "…and declining is a real option, not a dead-end OK")
  assert.ok(declined.message.includes("ADVANCED · TIMING"), "the declined preview was the full summary")
})

test("Confirming closes the settings — no menu is left open behind the preview", async () => {
  const { ports, calls } = scripted({ select: ["advanced", "maxTime", "10800000", "back", "save"], confirm: [true] })
  await runSettingsFlow(ports)
  const titles = calls.selects.map((s) => s.title)
  assert.equal(titles.at(-1).startsWith("Advisor Settings"), true, "the last thing rendered is the menu we saved from")
  const settingsRenders = titles.filter((t) => t.startsWith("Advisor Settings")).length
  assert.equal(settingsRenders, 2, `the initial render and the one before Save — nothing after Confirm (${JSON.stringify(titles)})`)
  assert.ok(calls.toasts.some((x) => x.message.startsWith("Saved to")), `a toast confirms it (${JSON.stringify(calls.toasts)})`)
  assert.ok(!calls.alerts.length, "no second blocking dialog after the preview")
})

test("the preview reflects a preset expansion, not the raw draft", async () => {
  const { ports, calls } = scripted({ select: ["preset", "thorough", "save"], confirm: [true] })
  await runSettingsFlow(ports)
  const preview = calls.confirms[0].message
  // Thorough expands to 64K context / 16K advice; a naive echo of the draft
  // would show the OLD balanced numbers.
  assert.ok(preview.includes("64K tokens"), `the preview expands the preset:\n${preview}`)
  assert.ok(preview.includes("16K tokens"), `…for advice too:\n${preview}`)
  assert.ok(preview.includes("Thorough"), "and names the preset")
  assert.deepEqual(calls.saved, [{ preset: "thorough" }], "only the preset key is written")
})

test("projectView is pure — it never writes and it mirrors resolveOptions", () => {
  const view = makeView()
  const before = JSON.stringify(view)
  const projected = projectView(view, { transcriptBudgetTokens: "64k", maxToolOutputTokens: 2000, preset: "thorough" })
  assert.equal(JSON.stringify(view), before, "the source view is untouched")
  assert.equal(projected.config.transcriptBudgetTokens, 64_000, "a size string is resolved")
  assert.equal(projected.config.adviceTokenBudget, 16_000, "the preset's advice budget applies")
  assert.equal(projected.config.maxToolOutputTokens, 2000, "an explicit key overrides")
  // Inherit removes the key, so the projection falls back to the default.
  assert.equal(projectView(view, { logLevel: null }).config.logLevel, "info", "null falls back to the default")
  // And it agrees with the real resolver, which is the only thing that makes
  // the preview trustworthy.
  const real = resolveOptions({ transcriptBudgetTokens: 64_000, maxToolOutputTokens: 2000, maxUsesPerTask: 5, adviceTokenBudget: 16_000 })
  assert.equal(projected.config.maxUsesPerTask, real.maxUsesPerTask, "consults match the resolver")
  assert.equal(projected.config.adviceTokenBudget, real.adviceTokenBudget, "advice matches the resolver")
})
