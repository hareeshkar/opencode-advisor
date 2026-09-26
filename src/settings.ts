/**
 * Advisor settings — pure logic for the /advisor-settings menu.
 *
 * Everything user-facing lives here: labels, preset consequences, draft
 * semantics, and the sequential menu flow. The TUI plugin is a thin adapter
 * over the dialogs; tests drive the same flow with scripted ports.
 *
 * Draft semantics (the key to a truthful UI):
 *   key absent      → untouched; display the effective value from the files
 *   key === null    → remove the key from the target file ("Inherit")
 *   key === value   → write that explicit value on Save
 *
 * Nothing is written until Save. Cancel discards. The editor never edits
 * preset-expanded values implicitly, so a preset stays a one-word knob.
 */

import { ADVISOR_CONFIG_KEYS } from "./config.js"
import { PRESETS } from "./options.js"

/* ------------------------------- RPC schemas ------------------------------ */

/** Effective config + provenance — the server's get/set/reset output. */
export const CONFIG_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    config: {
      type: "object",
      properties: {
        providerID: { type: "string" },
        id: { type: "string" },
        variant: { type: "string" },
        source: { type: "string" },
        preset: { type: "string" },
        advisorMode: { type: "string" },
        maxUsesPerTask: { type: "number" },
        maxAttempts: { type: "number" },
        advisorResponseWaitMs: { type: "number" },
        maxConsultMs: { type: "number" },
        adviceTokenBudget: { type: "number" },
        transcriptBudgetTokens: { type: "number" },
        maxToolOutputChars: { type: "number" },
        triggers: { type: "array", items: { type: "string" } },
        logLevel: { type: "string" },
      },
      required: [
        "providerID",
        "id",
        "variant",
        "source",
        "preset",
        "advisorMode",
        "maxUsesPerTask",
        "maxAttempts",
        "advisorResponseWaitMs",
        "maxConsultMs",
        "adviceTokenBudget",
        "transcriptBudgetTokens",
        "maxToolOutputChars",
        "triggers",
        "logLevel",
      ],
      additionalProperties: false,
    },
    tiers: { type: "object", additionalProperties: { type: "string" } },
    files: {
      type: "object",
      properties: {
        global: { type: "string" },
        project: { type: "string" },
        used: { type: "array", items: { type: "string" } },
      },
      required: ["global", "project", "used"],
      additionalProperties: false,
    },
  },
  required: ["config", "tiers", "files"],
  additionalProperties: false,
} as const

/** `set` accepts a full draft document (preferred) or the legacy pre-0.7 pick. */
export const CONFIG_SET_INPUT_SCHEMA = {
  type: "object",
  properties: {
    doc: { type: "object", additionalProperties: true },
    scope: { type: "string" },
    providerID: { type: "string" },
    id: { type: "string" },
    variant: { type: "string" },
  },
  additionalProperties: false,
} as const

/* --------------------------------- types ---------------------------------- */

export interface AdvisorSettingsView {
  config: {
    providerID: string
    id: string
    variant: string
    source: string
    preset: string
    advisorMode: string
    maxUsesPerTask: number
    maxAttempts: number
    advisorResponseWaitMs: number
    maxConsultMs: number
    adviceTokenBudget: number
    transcriptBudgetTokens: number
    maxToolOutputChars: number
    triggers: string[]
    logLevel: string
  }
  tiers: Record<string, string>
  files: { global: string; project: string; used: string[] }
}

export type SettingsDraft = Record<string, unknown>

export interface SettingsModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface SettingsModelInfo {
  providerID: string
  id: string
  name?: string
  variants?: readonly string[]
}

export interface SettingsSelectOption {
  title: string
  value: string
  description?: string
  footer?: string
  category?: string
  disabled?: boolean
}

export interface SettingsPorts {
  load(): Promise<AdvisorSettingsView>
  save(doc: SettingsDraft): Promise<AdvisorSettingsView>
  select(request: { title: string; placeholder?: string; options: SettingsSelectOption[]; current?: string }): Promise<string | undefined>
  alert(options: { title: string; message: string }): Promise<void>
  confirm(options: { title: string; message: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean | undefined>
  prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): void
  models(): Promise<SettingsModelInfo[]>
}

export interface MenuRow {
  title: string
  value: string
  description: string
  category: string
}

/* ------------------------------- formatting ------------------------------- */

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1)))
}

/** 32000 → "32K", 1500 → "1.5K", 500000 → "500K", 1000000 → "1M". */
export function formatSize(chars: number): string {
  if (!Number.isFinite(chars)) return String(chars)
  if (chars >= 1_000_000) return `${trimNumber(chars / 1_000_000)}M`
  if (chars >= 1_000) return `${trimNumber(chars / 1000)}K`
  return String(Math.floor(chars))
}

/** 90000 → "90s", 120000 → "2 min", 3600000 → "1h", 86400000 → "24h". */
export function formatDuration(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${trimNumber(ms / 60_000)} min`
  return `${trimNumber(ms / 3_600_000)}h`
}

/** Human sizes in config files: 32000 | "32k" | "1.5m" (1000-based). */
export function parseHumanSize(value: number | string): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value !== "string") return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(value.trim())
  if (!match) return undefined
  return Math.floor(Number.parseFloat(match[1]!) * (match[2] ? (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1))
}

export function presetTitle(name: string): string {
  const base = name.charAt(0).toUpperCase() + name.slice(1)
  return name === "balanced" ? `${base} (recommended)` : base
}

/** Single source of truth: consequences are derived from PRESETS. */
export function presetBlurb(name: string): string {
  const preset = PRESETS[name]
  if (!preset) return ""
  const uses = preset.maxUsesPerTask as number
  const context = parseHumanSize(preset.transcriptBudgetTokens as string | number) ?? 0
  const advice = preset.adviceTokenBudget as number
  return `${uses} consult${uses === 1 ? "" : "s"}/task · ${formatSize(context)} context tokens · ${formatSize(advice)} advice tokens`
}

export function tierLabel(tier: string | undefined): string {
  switch (tier) {
    case "project":
      return "project file"
    case "global":
      return "global file"
    case "deployment":
      return "opencode.json"
    case "default":
      return "default"
    default:
      return "default"
  }
}

export function modelLabel(ref: SettingsModelRef): string {
  return `${ref.id}${ref.variant ? ` · ${ref.variant}` : ""}`
}

export function hasChanges(draft: SettingsDraft): boolean {
  return Object.keys(draft).length > 0
}

/* ------------------------------ display state ----------------------------- */

export interface ModelDisplay {
  configured: boolean
  inherit: boolean
  label: string
  description: string
  ref?: SettingsModelRef
}

export function currentModel(view: AdvisorSettingsView, draft: SettingsDraft): ModelDisplay {
  if (draft.advisor === null) {
    return {
      configured: false,
      inherit: true,
      label: "Inherit (no advisor set here)",
      description: "Removes the advisor key; falls back to other config layers",
    }
  }
  const drafted = draft.advisor && typeof draft.advisor === "object" ? (draft.advisor as SettingsModelRef) : undefined
  const ref: SettingsModelRef | undefined = drafted
    ? drafted
    : view.config.providerID !== "" && view.config.id !== ""
      ? { providerID: view.config.providerID, id: view.config.id, ...(view.config.variant ? { variant: view.config.variant } : {}) }
      : undefined
  if (!ref) {
    return {
      configured: false,
      inherit: false,
      label: "Not configured",
      description: "Required before consultation — pick a model",
    }
  }
  const origin = drafted ? "this change" : tierLabel(view.tiers.advisor)
  return {
    configured: true,
    inherit: false,
    label: modelLabel(ref),
    description: `${ref.providerID}/${ref.id} · from ${origin}`,
    ref,
  }
}

export type PresetKind = "preset" | "custom" | "inherit"

export interface PresetDisplay {
  kind: PresetKind
  name: string
  title: string
  blurb: string
  isDefault: boolean
}

/** A preset's three controlled quantities (context/advice in TOKENS). */
export function presetExpansion(name: string): { consults: number; contextTokens: number; adviceTokens: number } {
  const preset = PRESETS[name] ?? PRESETS.balanced!
  return {
    consults: preset.maxUsesPerTask as number,
    contextTokens: parseHumanSize(preset.transcriptBudgetTokens as string | number) ?? 16_000,
    adviceTokens: preset.adviceTokenBudget as number,
  }
}

/**
 * Preset = exactly its expansion, resolved like the runtime would: explicit
 * draft keys win; explicit file/deployment keys beat the preset; otherwise
 * the declared preset expands (default: balanced). Any deviation ⇒ Custom —
 * computed, never persisted, so the row never lies about the effective mix.
 */
export function currentPreset(view: AdvisorSettingsView, draft: SettingsDraft): PresetDisplay {
  if (draft.preset === null) {
    return { kind: "inherit", name: "", title: "Inherit", blurb: "No preset key in this file — falls back to other layers", isDefault: false }
  }
  const declaredRaw = draft.preset !== undefined ? draft.preset : view.config.preset
  const declared = typeof declaredRaw === "string" && declaredRaw !== "" ? declaredRaw : ""
  const draftedPreset = typeof draft.preset === "string" && draft.preset !== "" ? draft.preset : undefined
  const base = presetExpansion(declared)
  const resolveKey = (draftKey: string, baseValue: number): number => {
    if (draft[draftKey] === null) return baseValue
    if (draft[draftKey] !== undefined) return draft[draftKey] as number
    // A freshly drafted preset means the server-resolved values are stale for
    // keys the new preset would control — unless an explicit file/deployment
    // value persists and overrides it (tier-attributed), which keeps its value.
    if (draftedPreset !== undefined && view.tiers[draftKey] === undefined) return baseValue
    return (view.config as unknown as Record<string, number>)[draftKey] ?? baseValue
  }
  const effective = {
    consults: resolveKey("maxUsesPerTask", base.consults),
    contextTokens: resolveKey("transcriptBudgetTokens", base.contextTokens),
    adviceTokens: resolveKey("adviceTokenBudget", base.adviceTokens),
  }
  const match = Object.keys(PRESETS).find((name) => {
    const expansion = presetExpansion(name)
    return (
      expansion.consults === effective.consults &&
      expansion.contextTokens === effective.contextTokens &&
      expansion.adviceTokens === effective.adviceTokens
    )
  })
  if (match) {
    return {
      kind: "preset",
      name: match,
      title: presetTitle(match),
      blurb: presetBlurb(match),
      isDefault: declared === "" && match === "balanced",
    }
  }
  return {
    kind: "custom",
    name: "",
    title: "Custom",
    blurb: "Effective limits match no preset — pick one to snap back, or keep this mix",
    isDefault: false,
  }
}

export interface ModeDisplay {
  mode: "review" | "agent"
  title: string
  description: string
  inherit: boolean
}

export const MODE_DESCRIPTIONS: Record<"review" | "agent", string> = {
  review: "Pruned conversation → compact advice. Fastest, most economical (default).",
  agent: "Review + Agent — the conversation is the map; the advisor verifies the implicated files with read-only tools before advising.",
}

export function currentMode(view: AdvisorSettingsView, draft: SettingsDraft): ModeDisplay {
  const value = draft.advisorMode !== undefined ? draft.advisorMode : view.config.advisorMode
  if (value === null) {
    return { mode: "review", title: "Inherit", description: "No mode key in this file — falls back to other layers", inherit: true }
  }
  const mode = value === "agent" ? "agent" : "review"
  return { mode, title: mode === "agent" ? "Review + Agent" : "Review", description: MODE_DESCRIPTIONS[mode], inherit: false }
}

export interface LimitsDisplay {
  consults: number
  /** How long the executor waits for advice before continuing in the background. */
  responseWaitMs: number
  /** Maximum advisor lifetime; expiry fails the consult without consuming the cap. */
  ceilingMs: number
  /** INPUT context budget, in tokens (≈4 chars/token when pruning). */
  contextTokens: number
  /** OUTPUT budget for the advisor's reply, in tokens. */
  adviceTokens: number
  toolCap: number
  attempts: number
  logLevel: string
  inherit: Record<string, boolean>
}

export function currentLimits(view: AdvisorSettingsView, draft: SettingsDraft): LimitsDisplay {
  const inherit: Record<string, boolean> = {}
  const pick = (key: string, fallback: number | string): number | string => {
    if (draft[key] !== undefined) {
      inherit[key] = draft[key] === null
      return draft[key] === null ? fallback : (draft[key] as number | string)
    }
    return (view.config as unknown as Record<string, number | string>)[key] ?? fallback
  }
  return {
    consults: pick("maxUsesPerTask", 3) as number,
    responseWaitMs: pick("advisorResponseWaitMs", 90_000) as number,
    ceilingMs: pick("maxConsultMs", 3_600_000) as number,
    contextTokens: pick("transcriptBudgetTokens", 16_000) as number,
    adviceTokens: pick("adviceTokenBudget", 8_000) as number,
    toolCap: pick("maxToolOutputChars", 1_500) as number,
    attempts: pick("maxAttempts", 11) as number,
    logLevel: pick("logLevel", "info") as string,
    inherit,
  }
}

/* --------------------------------- rows ----------------------------------- */

export function mainMenuRows(view: AdvisorSettingsView, draft: SettingsDraft): MenuRow[] {
  const target = view.files.project || view.files.global
  const model = currentModel(view, draft)
  const preset = currentPreset(view, draft)
  const mode = currentMode(view, draft)
  const limits = currentLimits(view, draft)
  return [
    { category: "Settings", value: "model", title: `Advisor model — ${model.label}`, description: model.description },
    {
      category: "Settings",
      value: "preset",
      title: `Preset — ${preset.title}${preset.kind === "preset" && preset.isDefault ? " · default" : ""}`,
      description: preset.blurb,
    },
    { category: "Settings", value: "mode", title: `Mode — ${mode.title}`, description: mode.description },
    {
      category: "Settings",
      value: "limits",
      title: `Limits — ${limits.consults} consults/task · response wait ${formatDuration(limits.responseWaitMs)}`,
      description: `${formatSize(limits.contextTokens)} context tokens · ${formatSize(limits.adviceTokens)} advice tokens · ceiling ${formatDuration(limits.ceilingMs)} · ${limits.attempts} retries`,
    },
    { category: "Actions", value: "save", title: "Save changes", description: hasChanges(draft) ? `Write to ${target}` : "No changes yet" },
    { category: "Actions", value: "reset", title: "Reset all settings…", description: `Remove the plugin's keys from ${target}` },
    { category: "Actions", value: "cancel", title: "Cancel", description: hasChanges(draft) ? "Discard unsaved changes" : "Close" },
  ]
}

export function limitRows(view: AdvisorSettingsView, draft: SettingsDraft): MenuRow[] {
  const limits = currentLimits(view, draft)
  return [
    { category: "", value: "consults", title: `Consults per task — ${limits.consults}`, description: "Advisor calls allowed per user task (safety cap)" },
    { category: "", value: "wait", title: `Response wait — ${formatDuration(limits.responseWaitMs)}`, description: "How long to wait for advisor advice before continuing in the background (the advisor keeps running)" },
    { category: "Advanced", value: "ceiling", title: `Consult ceiling — ${formatDuration(limits.ceilingMs)}`, description: "Maximum advisor lifetime; expiry fails the consult without consuming the cap" },
    {
      category: "Advanced",
      value: "context",
      title: `Context budget — ${formatSize(limits.contextTokens)} tokens`,
      description: "INPUT tokens of conversation sent to the advisor (up to the model's context window)",
    },
    {
      category: "Advanced",
      value: "advice",
      title: `Advice length — ${formatSize(limits.adviceTokens)} tokens`,
      description: "OUTPUT tokens for the advisor's reply (under the model's max output limit)",
    },
    {
      category: "Advanced",
      value: "toolcap",
      title: `Per-tool output cap — ${formatSize(limits.toolCap)} chars`,
      description: "Maximum characters kept from a single tool output",
    },
    {
      category: "Advanced",
      value: "retries",
      title: `Retry ceiling — ${limits.attempts}`,
      description: "Transport attempts per task — NOT extra paid consults",
    },
    { category: "Advanced", value: "loglevel", title: `Log level — ${limits.logLevel}`, description: "Plugin diagnostics verbosity" },
    { category: "Actions", value: "back", title: "← Back", description: "Return to the main menu" },
  ]
}

/* -------------------------------- summary --------------------------------- */

export function summaryMessage(view: AdvisorSettingsView): string {
  const model = currentModel(view, {})
  const preset = currentPreset(view, {})
  const mode = currentMode(view, {})
  const limits = currentLimits(view, {})
  return [
    `Model     ${model.label}`,
    `Preset    ${preset.title}${preset.kind === "preset" && preset.isDefault ? " (default)" : ""} — ${preset.blurb}`,
    `Mode      ${mode.title} — ${MODE_DESCRIPTIONS[mode.mode]}`,
    `Limits    ${limits.consults} consults/task · response wait ${formatDuration(limits.responseWaitMs)} · ${formatSize(limits.contextTokens)} context tokens · ${formatSize(limits.adviceTokens)} advice tokens`,
    `File      ${view.files.project || view.files.global}`,
    `Applies immediately — no restart.`,
  ].join("\n")
}

/* --------------------------------- flow ----------------------------------- */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function discardOrKeep(ports: SettingsPorts, draft: SettingsDraft): Promise<boolean> {
  if (!hasChanges(draft)) return true
  const ok = await ports.confirm({
    title: "Discard changes?",
    message: "Your unsaved advisor settings will be lost.",
    confirmLabel: "Discard",
    cancelLabel: "Keep editing",
  })
  return ok === true
}

async function pickNumber(
  ports: SettingsPorts,
  args: {
    title: string
    description: string
    current: number
    choices: number[]
    format: (n: number) => string
    parse: (raw: string) => number | undefined
    min: number
    max: number
    rangeHint: string
  },
): Promise<number | null | undefined> {
  const options: SettingsSelectOption[] = [
    { category: "Actions", title: "Inherit — remove this key", value: "__inherit__", description: "Falls back to the preset / other config layers" },
    ...args.choices.map((n) => ({ title: args.format(n), value: String(n) })),
    { category: "Actions", title: "Custom…", value: "__custom__", description: `Enter a value (${args.rangeHint})` },
  ]
  const choice = await ports.select({ title: args.title, current: String(args.current), options })
  if (choice === undefined) return undefined
  if (choice === "__inherit__") return null
  if (choice !== "__custom__") {
    const n = Number(choice)
    return Number.isFinite(n) ? n : undefined
  }
  const raw = await ports.prompt({
    title: args.title,
    description: `${args.description} (${args.rangeHint})`,
    placeholder: String(args.current),
    value: String(args.current),
  })
  if (raw === undefined) return undefined
  const parsed = args.parse(raw.trim())
  if (parsed === undefined || parsed < args.min || parsed > args.max) {
    await ports.alert({ title: "Invalid value", message: `Enter a value between ${args.rangeHint}.` })
    return undefined
  }
  return parsed
}

async function runLimitsMenu(ports: SettingsPorts, view: AdvisorSettingsView, draft: SettingsDraft): Promise<void> {
  for (;;) {
    const choice = await ports.select({ title: "Limits", options: limitRows(view, draft) })
    if (choice === undefined || choice === "back") return
    let next: number | null | undefined
    switch (choice) {
      case "consults":
        next = await pickNumber(ports, {
          title: "Consults per task",
          description: "Advisor calls allowed per user task",
          current: currentLimits(view, draft).consults,
          choices: [1, 2, 3, 5, 8, 10],
          format: (n) => `${n}`,
          parse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : undefined),
          min: 1,
          max: 50,
          rangeHint: "1–50",
        })
        break
      case "wait":
        next = await pickNumber(ports, {
          title: "Response wait",
          description: "How long to wait for advisor advice before continuing in the background",
          current: currentLimits(view, draft).responseWaitMs,
          choices: [30_000, 60_000, 90_000, 120_000, 180_000, 300_000],
          format: formatDuration,
          parse: (raw) => {
            const seconds = /^\d+$/.test(raw) ? Number(raw) : undefined
            return seconds === undefined ? undefined : seconds * 1000
          },
          min: 1_000,
          max: 600_000,
          rangeHint: "1–600 seconds",
        })
        break
      case "ceiling":
        next = await pickNumber(ports, {
          title: "Consult ceiling",
          description: "Maximum advisor lifetime; expiry fails the consult without consuming the cap",
          current: currentLimits(view, draft).ceilingMs,
          choices: [300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 86_400_000],
          format: formatDuration,
          parse: parseHumanSize,
          min: 30_000,
          max: 86_400_000,
          rangeHint: "30s–24h, e.g. 1h",
        })
        break
      case "context":
        next = await pickNumber(ports, {
          title: "Context budget",
          description: "INPUT tokens of pruned conversation sent to the advisor",
          current: currentLimits(view, draft).contextTokens,
          choices: [8_000, 16_000, 32_000, 64_000, 128_000, 500_000, 1_000_000],
          format: formatSize,
          parse: parseHumanSize,
          min: 2_000,
          max: 1_000_000,
          rangeHint: "2K–1M tokens, e.g. 128k",
        })
        break
      case "advice":
        next = await pickNumber(ports, {
          title: "Advice length",
          description: "OUTPUT token budget for the advisor's reply",
          current: currentLimits(view, draft).adviceTokens,
          choices: [4_000, 8_000, 16_000, 32_000],
          format: formatSize,
          parse: parseHumanSize,
          min: 500,
          max: 64_000,
          rangeHint: "500–64000 tokens (model caps are typically 8K–65K)",
        })
        break
      case "toolcap":
        next = await pickNumber(ports, {
          title: "Per-tool output cap",
          description: "Maximum characters kept from a single tool output",
          current: currentLimits(view, draft).toolCap,
          choices: [500, 1_000, 1_500, 3_000, 8_000],
          format: formatSize,
          parse: parseHumanSize,
          min: 100,
          max: 200_000,
          rangeHint: "100–200000 chars",
        })
        break
      case "retries":
        next = await pickNumber(ports, {
          title: "Retry ceiling",
          description: "Maximum dispatch attempts per task",
          current: currentLimits(view, draft).attempts,
          choices: [5, 8, 11, 16, 25],
          format: (n) => `${n}`,
          parse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : undefined),
          min: 1,
          max: 100,
          rangeHint: "1–100",
        })
        break
      case "loglevel": {
        const current = currentLimits(view, draft).logLevel
        const picked = await ports.select({
          title: "Log level",
          current,
          options: [
            { category: "Actions", title: "Inherit — remove this key", value: "__inherit__", description: "Falls back to other config layers" },
            { title: "info", value: "info", description: "Normal diagnostics (default)" },
            { title: "debug", value: "debug", description: "Verbose — hook and injection observability" },
            { title: "warn", value: "warn", description: "Warnings and errors only" },
            { title: "error", value: "error", description: "Errors only" },
          ],
        })
        if (picked === undefined) break
        draft.logLevel = picked === "__inherit__" ? null : picked
        continue
      }
    }
    if (next !== undefined) {
      const key =
        choice === "consults"
          ? "maxUsesPerTask"
          : choice === "wait"
            ? "advisorResponseWaitMs"
            : choice === "ceiling"
              ? "maxConsultMs"
              : choice === "context"
                ? "transcriptBudgetTokens"
                : choice === "advice"
                  ? "adviceTokenBudget"
                  : choice === "toolcap"
                    ? "maxToolOutputChars"
                    : "maxAttempts"
      draft[key] = next
    }
  }
}

type ModelPick = { kind: "cancel" } | { kind: "inherit" } | { kind: "pick"; ref: SettingsModelRef }

async function pickModel(ports: SettingsPorts, view: AdvisorSettingsView, draft: SettingsDraft): Promise<ModelPick> {
  let models: SettingsModelInfo[] = []
  try {
    models = await ports.models()
  } catch {
    /* catalog unavailable — custom entry still works */
  }
  const effective = currentModel(view, draft)
  const options: SettingsSelectOption[] = [
    { category: "Actions", title: "Inherit — remove the advisor key", value: "__inherit__", description: "Falls back to other config layers; no advisor runs if nothing sets one" },
    { category: "Actions", title: "Custom — type providerID/model", value: "__custom__", description: "For models not in the catalog" },
  ]
  const seen = new Set<string>()
  if (effective.ref) {
    seen.add(`${effective.ref.providerID}/${effective.ref.id}`)
    options.push({
      category: "Current",
      title: modelLabel(effective.ref),
      value: "current",
      description: `${effective.ref.providerID}/${effective.ref.id} · in use now`,
    })
  }
  for (const m of models) {
    const key = `${m.providerID}/${m.id}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ category: "Models", title: m.id, value: key, description: `${m.providerID}${m.name ? ` · ${m.name}` : ""}` })
  }
  const choice = await ports.select({ title: "Advisor model", options })
  if (choice === undefined) return { kind: "cancel" }
  if (choice === "__inherit__") return { kind: "inherit" }
  if (choice === "current" && effective.ref) return { kind: "pick", ref: effective.ref }
  if (choice === "__custom__") {
    const raw = await ports.prompt({
      title: "Custom advisor model",
      description: "Format: providerID/modelID — e.g. zai-coding-plan/glm-5.3",
      placeholder: "providerID/modelID",
    })
    if (raw === undefined) return { kind: "cancel" }
    const cleaned = raw.trim()
    const slash = cleaned.indexOf("/")
    const providerID = slash > 0 ? cleaned.slice(0, slash) : ""
    const id = slash > 0 ? cleaned.slice(slash + 1) : ""
    if (providerID === "" || id === "") {
      await ports.alert({ title: "Invalid model", message: "Use providerID/modelID — e.g. zai-coding-plan/glm-5.3" })
      return { kind: "cancel" }
    }
    return { kind: "pick", ref: { providerID, id } }
  }
  const slash = choice.indexOf("/")
  const providerID = slash > 0 ? choice.slice(0, slash) : ""
  const id = slash > 0 ? choice.slice(slash + 1) : ""
  if (providerID === "" || id === "") return { kind: "cancel" }
  const model = models.find((m) => `${m.providerID}/${m.id}` === choice)
  const variants = model?.variants ?? []
  if (variants.length > 0) {
    const sameModel = effective.ref?.providerID === providerID && effective.ref?.id === id
    const picked = await ports.select({
      title: `Variant for ${id}`,
      current: sameModel ? (effective.ref?.variant ?? "") : "",
      options: [
        { title: "default", value: "", description: "Model default thinking effort" },
        ...variants.map((v) => ({ title: v, value: v })),
      ],
    })
    if (picked === undefined) return { kind: "cancel" }
    return { kind: "pick", ref: { providerID, id, ...(picked !== "" ? { variant: picked } : {}) } }
  }
  return { kind: "pick", ref: { providerID, id } }
}

export async function runSettingsFlow(ports: SettingsPorts): Promise<void> {
  let view: AdvisorSettingsView
  try {
    view = await ports.load()
  } catch (err) {
    ports.toast(`Could not read the advisor configuration: ${errorText(err)}`, "error")
    return
  }
  let draft: SettingsDraft = {}

  for (;;) {
    const title = hasChanges(draft) ? "Advisor Settings — unsaved changes" : "Advisor Settings"
    const choice = await ports.select({ title, options: mainMenuRows(view, draft) })

    if (choice === undefined) {
      if (await discardOrKeep(ports, draft)) return
      continue
    }

    if (choice === "cancel") {
      if (await discardOrKeep(ports, draft)) return
      continue
    }

    if (choice === "model") {
      const picked = await pickModel(ports, view, draft)
      if (picked.kind === "inherit") draft.advisor = null
      else if (picked.kind === "pick") draft.advisor = picked.ref
      continue
    }

    if (choice === "preset") {
      const current = currentPreset(view, draft)
      const options: SettingsSelectOption[] = [
        { category: "Actions", title: "Inherit — remove the preset key", value: "__inherit__", description: "Falls back to other config layers" },
        ...Object.keys(PRESETS).map((name) => ({ title: presetTitle(name), value: name, description: presetBlurb(name) })),
      ]
      if (current.kind === "custom") {
        options.unshift({
          category: "Current",
          title: "Custom — current effective mix",
          value: "__custom_current__",
          description: "Matches no preset; pick one below to snap back",
          disabled: true,
        })
      }
      const picked = await ports.select({
        title: "Preset — how much resource the advisor may use",
        current: current.kind === "preset" ? current.name : "",
        options,
      })
      if (picked !== undefined) draft.preset = picked === "__inherit__" ? null : picked
      continue
    }

    if (choice === "mode") {
      const current = currentMode(view, draft)
      const picked = await ports.select({
        title: "Mode — how the advisor investigates",
        current: current.mode,
        options: [
          { category: "Actions", title: "Inherit — remove the mode key", value: "__inherit__", description: "Falls back to other config layers" },
          { title: "Review", value: "review", description: MODE_DESCRIPTIONS.review },
          { title: "Review + Agent", value: "agent", description: MODE_DESCRIPTIONS.agent },
        ],
      })
      if (picked !== undefined) draft.advisorMode = picked === "__inherit__" ? null : picked
      continue
    }

    if (choice === "limits") {
      await runLimitsMenu(ports, view, draft)
      continue
    }

    if (choice === "save") {
      if (!hasChanges(draft)) {
        ports.toast("No changes to save.", "info")
        continue
      }
      try {
        const saved = await ports.save(draft)
        view = saved
        draft = {}
        await ports.alert({ title: "✓ Saved", message: summaryMessage(saved) })
      } catch (err) {
        ports.toast(`Save failed: ${errorText(err)}`, "error")
      }
      continue
    }

    if (choice === "reset") {
      const target = view.files.project || view.files.global
      const ok = await ports.confirm({
        title: "Reset all settings?",
        message: `Removes the advisor keys this plugin wrote to ${target}. Your other keys are untouched.`,
        confirmLabel: "Reset",
        cancelLabel: "Cancel",
      })
      if (ok !== true) continue
      try {
        const cleared = Object.fromEntries(ADVISOR_CONFIG_KEYS.map((key) => [key, null]))
        const saved = await ports.save(cleared)
        view = saved
        draft = {}
        await ports.alert({ title: "✓ Reset", message: summaryMessage(saved) })
      } catch (err) {
        ports.toast(`Reset failed: ${errorText(err)}`, "error")
      }
      continue
    }
  }
}
