/**
 * opencode-advisor — dual-export entrypoint.
 *
 * One default export serves both hosts, per the officially documented
 * packaging pattern:
 *   - OpenCode V2 calls `setup(ctx)`  (verified path)
 *   - OpenCode V1 ≥ 1.18.29 calls `server(input, options)`  (experimental)
 */

import { createV1Hooks } from "./v1.js"
import { createV2Plugin } from "./v2.js"

const v2 = createV2Plugin()

export default {
  id: v2.id,
  version: "0.1.0",
  setup: v2.setup,
  async server(input: unknown, options?: unknown): Promise<Record<string, unknown>> {
    return createV1Hooks(input, options)
  },
}

export { createV1Hooks, createV2Plugin }
export { AdvisorEngine } from "./engine.js"
export { pruneTranscript } from "./pruner.js"
export { resolveOptions, shouldNudgeExecutor } from "./options.js"
export { callAdvisorProvider } from "./providers.js"
