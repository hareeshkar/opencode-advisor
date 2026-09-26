/**
 * opencode-advisor — dual-export entrypoint.
 *
 * One default export serves both hosts, per the officially documented
 * packaging pattern:
 *   - OpenCode V2 calls `setup(ctx)`  (verified path)
 *   - OpenCode V1 ≥ 1.18.29 calls `server(input, options)`  (experimental)
 */

import { createV1Hooks, normalizeV1Messages } from "./v1.js"
import { createV2Plugin, extractLastAssistantText, normalizeV2Transcript } from "./v2.js"
import { PLUGIN_VERSION } from "./types.js"

const v2 = createV2Plugin()

export default {
  id: v2.id,
  version: PLUGIN_VERSION,
  setup: v2.setup,
  async server(input: unknown, options?: unknown): Promise<Record<string, unknown>> {
    return createV1Hooks(input, options)
  },
}

export { createV1Hooks, createV2Plugin }
export { extractLastAssistantText, normalizeV1Messages, normalizeV2Transcript }
export { AdvisorEngine, windowTranscript } from "./engine.js"
export { INJECTION_SENTINEL, extractToolNames, replaceSystemInBody } from "./inject.js"
export { pruneTranscript, clean } from "./pruner.js"
export { buildAdvisorPrompt, ADVISOR_TOOL_DESCRIPTION, AGENT_MODE_PREFIX, DEFAULT_TRIGGERS, advisorLabel, findTrigger, hasDirective, isAdvisorConfigured, isSettingsInvocation, notConfiguredMessage, shortlistAdvisorModels, triggerDirective } from "./prompts.js"
export { redactError, sanitizeEvidence, sanitizeAdviceText, frameAdvice, isAdvisorOutputFrame } from "./sanitize.js"
export { CONFIG_FILE_RELATIVE, PRESETS, mergeAdvisorConfigLayers, normalizeAdvisorMode, resolveOptions } from "./options.js"
export { ADVISOR_CONFIG_KEYS, ADVISOR_OVERRIDE_KEY, advisorConfigPaths, atomicWriteJson, loadAdvisorConfig, migrateStoredOverride, removeAdvisorConfigKeys, updateAdvisorConfig, writeAdvisorConfig } from "./config.js"
export type { AdvisorConfigFiles, AdvisorConfigSnapshot, AdvisorConfigTier, MigrationResult, OverrideStorage } from "./config.js"
export { CONFIG_OUTPUT_SCHEMA, CONFIG_SET_INPUT_SCHEMA, MODE_DESCRIPTIONS, currentLimits, currentMode, currentModel, currentPreset, formatDuration, formatSize, hasChanges, limitRows, mainMenuRows, parseHumanSize, presetBlurb, presetTitle, runSettingsFlow, summaryMessage, tierLabel } from "./settings.js"
export type { AdvisorSettingsView, MenuRow, SettingsDraft, SettingsModelInfo, SettingsPorts, SettingsSelectOption } from "./settings.js"
export { callAdvisorProvider } from "./providers.js"
export { PLUGIN_VERSION, PLUGIN_ID } from "./types.js"
