/** Pre-verify the on-disk config resolves to the values the scenario expects.
 *  Free (pure function) — catches config mistakes BEFORE a paid consult.
 *  Run: node preverify.mjs '<json>'   (or with no arg to read the live file) */
import { readFileSync } from "node:fs"
import { resolveOptions } from "file:///Users/hareeshkarravi/opencode-advisor/dist/opencode-advisor.js"

const P = process.env.HOME + "/.config/opencode/opencode-advisor.json"
const raw = process.argv[2] ? JSON.parse(process.argv[2]) : JSON.parse(readFileSync(P, "utf8"))
let o
try {
  o = resolveOptions(raw)
} catch (e) {
  console.log("RESOLVE_ERROR " + e.message)
  process.exit(1)
}
console.log(
  JSON.stringify({
    advisor: o.advisor.providerID + "/" + o.advisor.id,
    mode: o.advisorMode,
    maxUsesPerTask: o.maxUsesPerTask,
    maxAttempts: o.maxAttempts,
    advisorResponseWaitMs: o.advisorResponseWaitMs,
    maxConsultMs: o.maxConsultMs,
    transcriptBudgetTokens: o.transcriptBudgetTokens,
    adviceTokenBudget: o.adviceTokenBudget,
    toolOutputChars: o.prune.maxToolOutputChars,
    transcriptBudgetChars: o.prune.transcriptBudgetChars,
  }, null, 1),
)
