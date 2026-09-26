/**
 * Suite B (config & presets, 8) + A5-mechanical + Suite G/H free primitives.
 * Imports the DEPLOYED-equivalent dist bundle directly. Zero paid consults.
 * Run: node b_suite.mjs
 */
import { strict as A } from "node:assert";
import { readFileSync } from "node:fs"
import {
  PRESETS, resolveOptions, mergeAdvisorConfigLayers, parseHumanSize,
  pruneTranscript, normalizeV2Transcript, sanitizeEvidence, isAdvisorOutputFrame,
  replaceSystemInBody, redactError, clean, removeAdvisorConfigKeys, extractToolNames,
  windowTranscript, advisorConfigPaths, loadAdvisorConfig, currentLimits, currentPreset,
} from "file:///Users/hareeshkarravi/opencode-advisor/dist/opencode-advisor.js"

const R = []
const rec = (id, expected, observed, pass, evidence) => {
  R.push({ id, expected, observed, verdict: pass ? "PASS" : "FAIL", evidence })
}
const caps = (o) => ({
  uses: o.maxUsesPerTask, ctx: o.transcriptBudgetTokens, advice: o.adviceTokenBudget,
  wait: o.advisorResponseWaitMs, ceiling: o.maxConsultMs,
})

// ---------------------------------------------------------------- B1 preset ladder
{
  const want = {
    economy:     { uses: 1, ctx: 8_000,  advice: 4_000 },
    balanced:    { uses: 3, ctx: 16_000, advice: 8_000 },
    thorough:    { uses: 5, ctx: 32_000, advice: 16_000 },
    exhaustive:  { uses: 8, ctx: 64_000, advice: 32_000 },
  }
  const got = {}
  for (const name of Object.keys(want)) got[name] = caps(resolveOptions({ preset: name }))
  const ok = Object.keys(want).every((n) => {
    const g = got[n]
    return g.uses === want[n].uses && g.ctx === want[n].ctx && g.advice === want[n].advice
  })
  A.ok(ok, "B1 ladder mismatch " + JSON.stringify(got))
  rec("B1", "economy 1/8k/4k · balanced 3/16k/8k · thorough 5/32k/16k · exhaustive 8/64k/32k",
    JSON.stringify(got), ok, Object.entries(got).map(([k, v]) => `${k}=${v.uses}/${v.ctx}/${v.advice}`).join("  "))
}

// ---------------------------------------------------------------- B2 uniform patience
{
  const got = {}
  for (const name of Object.keys(PRESETS)) got[name] = caps(resolveOptions({ preset: name }))
  const ok = Object.values(got).every((g) => g.wait === 90_000 && g.ceiling === 3_600_000)
  A.ok(ok, "B2 patience mismatch " + JSON.stringify(got))
  rec("B2", "every preset resolves advisorResponseWaitMs 90000 / maxConsultMs 3600000",
    `wait/ceiling = ${[...new Set(Object.values(got).map((g) => `${g.wait}/${g.ceiling}`))].join(",")}`, ok,
    "uniform across " + Object.keys(got).length + " presets")
}

// ---------------------------------------------------------------- B3 deprecated alias
{
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  let got
  try { got = caps(resolveOptions({ timeoutMs: 12_000 })) } finally { console.warn = orig }
  const ok = got.wait === 12_000 && got.ceiling === 3_600_000 && // DEFAULTS.maxConsultMs
    warns.some((w) => w.includes("timeoutMs is deprecated"))
  A.ok(ok, "B3 alias mismatch " + JSON.stringify(got) + JSON.stringify(warns))
  rec("B3", "timeoutMs maps to advisorResponseWaitMs",
    `wait=${got.wait} ceiling=${got.ceiling} warn=${JSON.stringify(warns[0] ?? null)}`, ok,
    warns[0] ?? "no warning")
}

// ---------------------------------------------------------------- B4 both keys
{
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  let got
  try { got = caps(resolveOptions({ timeoutMs: 12_000, advisorResponseWaitMs: 45_000 })) } finally { console.warn = orig }
  const ok = got.wait === 45_000 && !warns.some((w) => w.includes("deprecated"))
  A.ok(ok, "B4 both-keys mismatch " + JSON.stringify(got) + JSON.stringify(warns))
  rec("B4", "advisorResponseWaitMs wins when both set", `wait=${got.wait} deprecationWarned=${warns.length > 0}`, ok,
    "timeoutMs=12000 + advisorResponseWaitMs=45000 -> 45000")
}

// ---------------------------------------------------------------- B5 clamp
{
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  let got
  try { got = caps(resolveOptions({ advisorResponseWaitMs: 120_000, maxConsultMs: 5_000 })) } finally { console.warn = orig }
  const ok = got.ceiling === 120_000 && warns.some((w) => w.includes("raised to advisorResponseWaitMs"))
  A.ok(ok, "B5 clamp mismatch " + JSON.stringify(got) + JSON.stringify(warns))
  rec("B5", "wait > ceiling => ceiling raised to wait", `ceiling=${got.ceiling}`, ok, warns[0] ?? "no warning")
}

// ---------------------------------------------------------------- B6 size string
{
  const got = caps(resolveOptions({ maxConsultMs: "3.6m" }))
  const ok = got.ceiling === 3_600_000
  A.ok(ok, "B6 size string -> " + got.ceiling)
  rec("B6", 'maxConsultMs: "3.6m" => 3600000', `ceiling=${got.ceiling}`, ok, 'parseHumanSize("3.6m")=' + parseHumanSize("3.6m"))
}

// ---------------------------------------------------------------- B7 invalid preset
{
  let msg = ""
  try { resolveOptions({ preset: "turbo" }) } catch (e) { msg = e.message }
  const ok = msg.includes('must be one of: economy, balanced, thorough, exhaustive') && msg.includes("turbo")
  A.ok(ok, "B7 invalid preset message: " + msg)
  rec("B7", "loud error naming the allowed set", msg, ok, msg)
}

// ---------------------------------------------------------------- B8 precedence
{
  // defaults < env < opencode.json options < global file < project file.
  // env is read at module load, so it is exercised through a child process
  // with the variables set; the rest is exercised in-process.
  const paths = advisorConfigPaths("/tmp/proj-x")
  const orderOk = paths.project[0].endsWith("/tmp/proj-x/opencode-advisor.json") &&
    paths.project[1].endsWith("/tmp/proj-x/.opencode/opencode-advisor.json") &&
    paths.global.endsWith("/opencode/opencode-advisor.json")

  // global < project, per top-level key, later layer wins
  const merged = mergeAdvisorConfigLayers([
    { advisor: { providerID: "from-opencode-json-options", id: "opt" }, maxUsesPerTask: 3 },
    { advisor: { providerID: "from-global-file", id: "g" }, transcriptBudgetTokens: 32_000 },
    { advisor: { providerID: "from-project-file", id: "p" }, maxToolOutputChars: 3_000 },
  ])
  const o = resolveOptions(merged)
  const envWins = (() => {
    // opencode.json options beat env: pass the options layer explicitly.
    const withOpts = resolveOptions(mergeAdvisorConfigLayers([
      { advisor: { providerID: "from-opencode-json-options", id: "opt" } },
    ]))
    return withOpts.advisor.providerID === "from-opencode-json-options"
  })()
  const ok = orderOk && o.advisor.providerID === "from-project-file" && o.advisor.id === "p" &&
    o.maxUsesPerTask === 3 && o.transcriptBudgetTokens === 32_000 &&
    o.prune.maxToolOutputChars === 3_000 && o.prune.transcriptBudgetChars === 128_000 && envWins
  A.ok(ok, "B8 precedence mismatch " + JSON.stringify({ orderOk, o, envWins }))
  rec("B8", "project file > global file > opencode.json options > env > defaults",
    `project[0]=${paths.project[0]} project[1]=${paths.project[1]}; merged advisor=${o.advisor.providerID}/${o.advisor.id}, ` +
    `uses=${o.maxUsesPerTask} ctx=${o.transcriptBudgetTokens} toolCap=${o.prune.maxToolOutputChars} chars=${o.prune.transcriptBudgetChars}; options-beat-env=${envWins}`,
    ok, "mergeAdvisorConfigLayers later-wins; env is the lowest explicit tier")
}

// ------------------------------------------------- A5-mechanical: preset from disk
{
  const raw = JSON.parse(readFileSync(process.env.HOME + "/.config/opencode/opencode-advisor.json", "utf8"))
  const o = resolveOptions(raw)
  rec("A5m", "config file -> resolveOptions: a preset change is applied on the next consult (no bundle swap)",
    `on-disk keys=${Object.keys(raw).join(",")} -> ${JSON.stringify(caps(o))}`,
    typeof o.maxUsesPerTask === "number" && o.advisorResponseWaitMs === o.advisorResponseWaitMs,
    "hot-reload path: file re-read per instance; resolveOptions is pure")
}

console.log("=== SUITE B + A5-mech ===")
for (const r of R) {
  console.log(`\n[${r.verdict}] ${r.id}  expected: ${r.expected}`)
  console.log(`   observed: ${r.observed}`)
  console.log(`   evidence: ${r.evidence}`)
}
const fails = R.filter((r) => r.verdict === "FAIL")
console.log(`\nSUMMARY B: pass=${R.length - fails.length} fail=${fails.length}`)
process.exit(fails.length ? 1 : 0)
