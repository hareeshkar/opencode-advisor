/**
 * Advisor configuration files — the persistent source of truth.
 *
 * Precedence, highest wins:
 *   defaults < deployment (env + opencode.json options) < global user file
 *   < project file (root convenience < canonical .opencode location).
 *
 * Every read failure that matters is LOUD: an unreadable or invalid config
 * file must never silently degrade to defaults. Writes are atomic
 * (tmp + fsync + rename) and flow through the server plugin's RPC surface so
 * exactly one process owns mutations.
 *
 * Rule of thumb for users: "project beats global beats deployment beats
 * defaults".
 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CONFIG_FILE_RELATIVE, mergeAdvisorConfigLayers } from "./options.js"

/** Storage key used by pre-0.7 builds for the /advisor-settings pick. */
export const ADVISOR_OVERRIDE_KEY = "advisor:override"

/** Which tier supplied a top-level config key. */
export type AdvisorConfigTier = "deployment" | "global" | "project"

export interface AdvisorConfigFiles {
  /** Global user file: $XDG_CONFIG_HOME/opencode/opencode-advisor.json */
  global: string
  /** Canonical project location: <dir>/.opencode/opencode-advisor.json */
  projectDotOpencode: string
  /** Convenience alias: <dir>/opencode-advisor.json (loses to .opencode). */
  projectRoot: string
  /** Project file that actually supplied the layer, or "" when none exists. */
  project: string
  /** Every file that existed and was read on this load. */
  used: string[]
}

export interface AdvisorConfigSnapshot {
  /** Raw option document: deployment options merged under file layers. */
  merged: Record<string, unknown>
  /** Winning tier per top-level key (keys absent here come from defaults/env). */
  tiers: Record<string, AdvisorConfigTier>
  files: AdvisorConfigFiles
}

/** Config file locations for a project directory (falls back to cwd). */
export function advisorConfigPaths(directory?: string): { global: string; project: string[] } {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config")
  const dir = directory && directory !== "" ? directory : process.cwd()
  // Array order is precedence: root convenience first, canonical .opencode last.
  return {
    global: join(base, "opencode", CONFIG_FILE_RELATIVE),
    project: [join(dir, CONFIG_FILE_RELATIVE), join(dir, ".opencode", CONFIG_FILE_RELATIVE)],
  }
}

function asPlainObject(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`[advisor] ${label} must contain a JSON object, got ${Array.isArray(v) ? "an array" : typeof v}`)
  }
  return v as Record<string, unknown>
}

async function readJsonFile(path: string): Promise<{ exists: boolean; doc: unknown }> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return { exists: false, doc: undefined }
    throw new Error(`[advisor] config file ${path} is unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return { exists: true, doc: JSON.parse(raw) }
  } catch (err) {
    throw new Error(`[advisor] config file ${path} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Load and merge every config layer with provenance. Project directory should
 * come from the host (ctx.location.directory); cwd is the fallback.
 */
export async function loadAdvisorConfig(args: { directory?: string; options?: unknown } = {}): Promise<AdvisorConfigSnapshot> {
  const paths = advisorConfigPaths(args.directory)
  const layers: Array<{ tier: AdvisorConfigTier; doc: Record<string, unknown> }> = []

  if (args.options !== undefined) {
    layers.push({ tier: "deployment", doc: asPlainObject(args.options, "plugin options") })
  }

  const used: string[] = []
  const globalRead = await readJsonFile(paths.global)
  if (globalRead.exists) {
    layers.push({ tier: "global", doc: asPlainObject(globalRead.doc, `config file ${paths.global}`) })
    used.push(paths.global)
  }

  let project = ""
  for (const path of paths.project) {
    const read = await readJsonFile(path)
    if (!read.exists) continue
    layers.push({ tier: "project", doc: asPlainObject(read.doc, `config file ${path}`) })
    used.push(path)
    project = path
  }

  const tiers: Record<string, AdvisorConfigTier> = {}
  for (const { tier, doc } of layers) for (const key of Object.keys(doc)) tiers[key] = tier

  return {
    merged: mergeAdvisorConfigLayers(layers.map((l) => l.doc)),
    tiers,
    files: {
      global: paths.global,
      projectDotOpencode: paths.project[1]!,
      projectRoot: paths.project[0]!,
      project,
      used,
    },
  }
}

/**
 * Atomic write: tmp file + fsync + rename over the target. The target is
 * always either the previous valid document or the new one — never a partial
 * write, even if the process dies mid-save.
 */
export async function atomicWriteJson(path: string, doc: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const json = `${JSON.stringify(doc, null, 2)}\n`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmp, "w", 0o644)
    await handle.writeFile(json, "utf8")
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  try {
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw new Error(`[advisor] failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Merge-write a draft over an existing config file. Whole top-level keys
 * replace (nested objects are units) — no deep-merge surprises. Unknown keys
 * the user added by hand are preserved.
 */
export async function writeAdvisorConfig(path: string, draft: Record<string, unknown>): Promise<void> {
  const existing = await readJsonFile(path)
  const base = existing.exists ? asPlainObject(existing.doc, `config file ${path}`) : {}
  await atomicWriteJson(path, { ...base, ...draft })
}

/** Remove the given top-level keys from a config file (no-op when absent). */
export async function removeAdvisorConfigKeys(path: string, keys: readonly string[]): Promise<void> {
  const existing = await readJsonFile(path)
  if (!existing.exists) return
  const base = asPlainObject(existing.doc, `config file ${path}`)
  for (const key of keys) delete base[key]
  await atomicWriteJson(path, base)
}

/** Every key this plugin understands — reset clears these; unknown keys survive. */
export const ADVISOR_CONFIG_KEYS = [
  "advisor",
  "source",
  "preset",
  "advisorMode",
  "maxUsesPerTask",
  "maxAttempts",
  "timeoutMs",
  "adviceWordBudget",
  "transcriptBudgetChars",
  "maxToolOutputChars",
  "triggers",
  "nudge",
  "injectTimingPrompt",
  "logLevel",
] as const

export interface OverrideStorage {
  get(key: string): Promise<unknown>
  remove(key: string): Promise<void>
}

export type MigrationResult = "none" | "migrated" | "dropped" | "failed"

/**
 * §6 migration for pre-0.7 installs: a pick stored by the old settings UI has
 * no file to land in. Move it to the global config file ONCE (a file always
 * wins over deployment defaults), then retire the storage key. If a config
 * file already supplies the advisor, the stale key is dropped silently.
 * On failure the key is kept — a user must never lose their pick.
 */
export async function migrateStoredOverride(args: {
  storage: OverrideStorage
  globalPath: string
  /** True when a config FILE (global or project) already sets `advisor`. */
  fileSetsAdvisor: boolean
  log?: (message: string) => void
}): Promise<MigrationResult> {
  let saved: unknown
  try {
    saved = await args.storage.get(ADVISOR_OVERRIDE_KEY)
  } catch {
    return "none"
  }
  if (saved === undefined || saved === null) return "none"

  const rec = saved as Record<string, unknown>
  const providerID = typeof rec.providerID === "string" ? rec.providerID : ""
  const id = typeof rec.id === "string" ? rec.id : ""
  const variant = typeof rec.variant === "string" && rec.variant !== "" ? rec.variant : undefined

  try {
    if (providerID !== "" && id !== "" && !args.fileSetsAdvisor) {
      await writeAdvisorConfig(args.globalPath, { advisor: { providerID, id, ...(variant ? { variant } : {}) } })
      await args.storage.remove(ADVISOR_OVERRIDE_KEY)
      args.log?.(`migrated the stored advisor selection to ${args.globalPath}`)
      return "migrated"
    }
    // Invalid pick, or a file already wins: drop the stale key silently.
    await args.storage.remove(ADVISOR_OVERRIDE_KEY)
    return "dropped"
  } catch {
    return "failed"
  }
}
