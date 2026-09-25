/**
 * opencode-advisor — dual-export entrypoint.
 *
 * One default export serves both hosts, per the officially documented
 * packaging pattern:
 *   - OpenCode V2 calls `setup(ctx)`  (verified path)
 *   - OpenCode V1 ≥ 1.18.29 calls `server(input, options)`  (experimental)
 */

import { createV1Hooks, normalizeV1Messages } from "./v1.js"
import { createV2Plugin, normalizeV2Transcript } from "./v2.js"
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
export { normalizeV1Messages, normalizeV2Transcript }
export { AdvisorEngine, windowTranscript } from "./engine.js"
export { pruneTranscript, clean } from "./pruner.js"
export { buildAdvisorPrompt, DEFAULT_TRIGGERS, findTrigger, hasDirective, triggerDirective } from "./prompts.js"
export { redactError, sanitizeEvidence, sanitizeAdviceText, frameAdvice } from "./sanitize.js"
export { resolveOptions, shouldNudgeExecutor } from "./options.js"
export { callAdvisorProvider } from "./providers.js"
export { PLUGIN_VERSION, PLUGIN_ID } from "./types.js"
