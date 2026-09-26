/** A6 (reset path) + Suite G (frame filter / draft strip) + Suite H (ledger internals).
 *  Free — no consults, no writes to the real config (fixtures live in a temp dir). */
import { strict as A } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ADVISOR_CONFIG_KEYS, ConsultLedger, removeAdvisorConfigKeys, isAdvisorOutputFrame,
  frameAdvice, pruneTranscript, normalizeV2Transcript, redactError, sanitizeEvidence,
  replaceSystemInBody,
} from "file:///Users/hareeshkarravi/opencode-advisor/dist/opencode-advisor.js"

const R = []
const rec = (id, expected, observed, pass, evidence) =>
  R.push({ id, expected, observed, verdict: pass ? "PASS" : "FAIL", evidence })

// ---------------------------------------------------------------- A6 reset path
{
  const dir = mkdtempSync(join(tmpdir(), "advisor-a6-"))
  const file = join(dir, "opencode-advisor.json")
  writeFileSync(file, JSON.stringify({
    advisor: { providerID: "p", id: "m" },
    transcriptBudgetTokens: 32000,
    maxToolOutputChars: 3000,
    advisorMode: "agent",
    preset: "thorough",
    // NON-advisor keys that must survive a reset untouched:
    $schema: "https://example.com/schema.json",
    theme: "tokyonight",
    editor: { fontSize: 14 },
  }, null, 2))
  const before = JSON.parse(readFileSync(file, "utf8"))
  A.ok(existsSync(file))
  await removeAdvisorConfigKeys(file, ADVISOR_CONFIG_KEYS)
  const after = JSON.parse(readFileSync(file, "utf8"))
  const advisorKeysGone = ADVISOR_CONFIG_KEYS.every((k) => !(k in after))
  const survivorsKept = after.$schema === before.$schema && after.theme === "thotonight" || true
  const ok = advisorKeysGone &&
    after.$schema === before.$schema && after.theme === before.theme &&
    JSON.stringify(after.editor) === JSON.stringify(before.editor) &&
    Object.keys(after).length === 3
  A.ok(ok, "A6 reset mismatch " + JSON.stringify(after))
  rec("A6", "reset-all-settings removes plugin keys from the file; other keys untouched",
    `removed ${ADVISOR_CONFIG_KEYS.length} advisor keys; survivors=${JSON.stringify(Object.keys(after))} ` +
    `values intact ($schema, theme, editor=${JSON.stringify(after.editor)})`,
    ok, "removeAdvisorConfigKeys(path, ADVISOR_CONFIG_KEYS) → atomicWriteJson; " +
        `ADVISOR_CONFIG_KEYS=[${ADVISOR_CONFIG_KEYS.join(",")}]`)

  // idempotence + absent-file no-op
  await removeAdvisorConfigKeys(file, ADVISOR_CONFIG_KEYS)
  const after2 = JSON.parse(readFileSync(file, "utf8"))
  const absentNoop = await removeAdvisorConfigKeys(join(dir, "nope.json"), ADVISOR_CONFIG_KEYS)
  rec("A6b", "reset is idempotent and a no-op on an absent file",
    `second reset identical=${JSON.stringify(after2) === JSON.stringify(after)}; absent file threw=${absentNoop}`,
    JSON.stringify(after2) === JSON.stringify(after) && absentNoop === undefined, "second pass + missing path")
}

// ---------------------------------------------------------------- G5 frame filter
{
  // Both live frame generations: review mode and Review+Agent mode, built by
  // the product's own frameAdvice(). Plus the legacy "by" spelling.
  const gen1 = frameAdvice("1. do a thing", "zai-coding-plan/glm-5.3", "review")
  const gen2 = frameAdvice("1. do another thing", "zai-coding-plan/glm-5.3", "agent")
  const legacy = "ADVISOR REVIEW by zai-coding-plan/glm-5.3 (peer second opinion — evaluate on merit)\n1. legacy advice"
  const both = isAdvisorOutputFrame(gen1) && isAdvisorOutputFrame(gen2) && isAdvisorOutputFrame(legacy)
  // The advisor's advice re-enters the executor transcript as a TOOL RESULT
  // (tool part) — that is the channel frames must be filtered from, alongside
  // `shell` messages. Model the real V2 message shape.
  const asTool = (text) => ({ type: "assistant", content: [{ type: "tool", name: "advisor", state: { output: text, status: "completed" } }] })
  const norm = normalizeV2Transcript([
    { type: "user", text: "ORIGINAL TASK" },
    { type: "assistant", content: [{ type: "text", text: "genuine assistant prose" }] },
    asTool(gen1),
    { type: "shell", text: gen2 },
    asTool(legacy),
    { type: "shell", text: "unrelated shell output" },
  ])
  // Frame exclusion happens at SLICE level (normalizeV2Transcript / pruner);
  // sanitizeEvidence's own job is delimiter neutralization. Test both honestly.
  const tagsNeutralized =
    sanitizeEvidence(`a <transcript-evidence> b </transcript> c <TRANSCRIPT_SOURCE> d`).includes("[redacted-tag]") &&
    !sanitizeEvidence(`<transcript-evidence>`).includes("<transcript")
  const noFrames = !norm.some((s) => isAdvisorOutputFrame(s.text)) && norm.some((s) => s.text.includes("genuine assistant prose"))
  A.ok(both, "G5 both frame generations recognised")
  A.ok(tagsNeutralized, "G5 tag neutralization failed")
  A.ok(noFrames, "G5 normalizeV2Transcript kept a frame: " + JSON.stringify(norm.map((s) => s.text.slice(0, 40))))
  rec("G5", "prior advisor frames excluded from evidence (both frame generations)",
    `isAdvisorOutputFrame: review-gen=${isAdvisorOutputFrame(gen1)} agent-gen=${isAdvisorOutputFrame(gen2)} legacy-"by"=${isAdvisorOutputFrame(legacy)}; ` +
    `normalizeV2Transcript dropped all 3 frame carriers (2 tool parts + 1 shell msg) =${noFrames} (kept ${norm.length} slice(s): ${JSON.stringify(norm.map((s) => s.role + ":" + s.text.slice(0, 22)))}); ` +
    `sanitizeEvidence neutralized forged transcript tags=${tagsNeutralized}`,
    both && tagsNeutralized && noFrames,
    "ADVISOR_FRAME matches the full tagline `(peer second opinion` on the title line, for both `·` and legacy `by` spellings and the `+ AGENT` variant")
}

// ---------------------------------------------------------------- G6 trailing-draft strip
{
  // Realistic shape: a completed prior turn is an assistant message followed
  // by its tool result; the in-flight draft is the terminal assistant message.
  const slices = [
    { type: "user", text: "ORIGINAL TASK" },
    { type: "assistant", content: [{ type: "text", text: "settled answer from the completed prior turn" }] },
    { type: "assistant", content: [{ type: "tool", name: "read", state: { output: "file contents", status: "completed" } }] },
    { type: "assistant", content: [{ type: "text", text: "in-flight draft that was never delivered" }] },
  ]
  const norm = normalizeV2Transcript(slices)
  const text = norm.map((s) => s.text).join("\n")
  const dropped = !text.includes("in-flight draft") && text.includes("settled answer from the completed prior turn")
  // And at least one slice always survives.
  const onlyDraft = normalizeV2Transcript([{ type: "assistant", content: [{ type: "text", text: "draft only" }] }])
  A.ok(dropped, "G6 draft not stripped: " + JSON.stringify(norm.map((s) => s.text)))
  A.ok(onlyDraft.length === 1, "G6 must always keep >=1 slice, got " + onlyDraft.length)
  rec("G6", "in-flight assistant drafts excluded from evidence",
    `input 4 messages (1 user, 1 settled answer, 1 tool-call turn, 1 in-flight draft) -> output ${norm.length} slices ` +
    `${JSON.stringify(norm.map((s) => s.role + ":" + s.text.slice(0, 24)))}; draft present=${!dropped}; settled prior turn kept=${text.includes("settled answer")}; all-assistant input still keeps 1 slice=${onlyDraft.length === 1}`,
    dropped && onlyDraft.length === 1,
    "normalizeV2Transcript pops the trailing assistant run while length > 1 — observed to strip the whole run (conservative superset of the stated contract), never fewer than the in-flight draft")
}

// ---------------------------------------------------------------- H2 lifecycle sweep
{
  let t = 1_000_000
  const saved = []
  const L = new ConsultLedger({ now: () => t }, { load: async () => undefined, save: async (r) => { saved.push(JSON.parse(JSON.stringify(r))) } })
  await L.hydrate()
  // CEILING=1000, grace=30_000 -> the reaper threshold is now-31_000.
  const CEILING = 1_000
  t = 900_000
  L.start({ id: "orphan-old", sessionID: "s", mode: "review", model: "p/m" })   // 100s before "now"
  t = 999_000
  L.start({ id: "in-window", sessionID: "s", mode: "review", model: "p/m" })    // 1s before "now"
  t = 1_000_000
  const reaped1 = L.reapStale(CEILING)
  const st1 = { inw: L.get("in-window")?.state, orph: L.get("orphan-old")?.state }
  const reaped2 = L.reapStale(CEILING) // idempotence
  const st2 = { inw: L.get("in-window")?.state, orph: L.get("orphan-old")?.state }
  const ok = reaped1.length === 1 && reaped1[0] === "orphan-old" && st1.inw === "running" &&
    st1.orph === "failed" && reaped2.length === 0 && st2.orph === "failed" &&
    /orphaned by restart/.test(L.get("orphan-old")?.error ?? "") &&
    L.runningCount() === 1
  A.ok(ok, "H2 sweep mismatch " + JSON.stringify({ reaped1, st1, reaped2, st2 }))
  rec("H2", "orphans past ceiling+grace failed once; in-window untouched; idempotent",
    `ceiling=${CEILING} grace=30000 threshold=now-31000; reap#1=${JSON.stringify(reaped1)} states=${JSON.stringify(st1)}; ` +
    `reap#2=${JSON.stringify(reaped2)} states=${JSON.stringify(st2)}; runningCount=${L.runningCount()}`,
    ok, `reaped error="${L.get("orphan-old")?.error}"`)
}

// ---------------------------------------------------------------- H5 persisted-advice cap
{
  const long = "A".repeat(5000)
  let saved = null
  const L = new ConsultLedger({ now: () => 42 }, { load: async () => undefined, save: async (r) => { saved = r } })
  await L.hydrate()
  L.start({ id: "c1", sessionID: "s", mode: "review", model: "p/m" })
  L.complete("c1", long)
  const CAP = 2000
  const durable = saved.find((r) => r.id === "c1")
  const inMemory = L.get("c1").advice
  const ok = durable.advice.length <= CAP + "…[truncated]".length && durable.advice.endsWith("…[truncated]") &&
    durable.advice.length === CAP + "…[truncated]".length && inMemory.length === 5000
  A.ok(ok, "H5 cap mismatch durable=" + durable.advice.length + " mem=" + inMemory.length)
  rec("H5", "durable copy truncates advice at 2000 chars; in-memory replay keeps full",
    `durable=${durable.advice.length} chars (ends "${durable.advice.slice(-14)}"), in-memory=${inMemory.length} chars`,
    ok, "ConsultLedger.persist() slices at PERSISTED_ADVICE_CAP=2000 + '…[truncated]'; entries Map keeps full")
}

// ---------------------------------------------------------------- H6 trim preference
{
  let t = 0
  const L = new ConsultLedger({ now: () => (t += 1) }, { load: async () => undefined, save: async () => {} })
  await L.hydrate()
  // 100 terminal records, then a RUNNING one -> the running record must survive the trim
  for (let i = 0; i < 100; i++) {
    L.start({ id: `t${i}`, sessionID: "s", mode: "review", model: "p/m" })
    L.complete(`t${i}`, "x")
  }
  L.start({ id: "RUNNING-ONE", sessionID: "s", mode: "review", model: "p/m" })
  L.start({ id: "newest", sessionID: "s", mode: "review", model: "p/m" }) // 101st -> triggers trim
  const survives = L.get("RUNNING-ONE")?.state
  const evictedOldestTerminal = L.get("t0") === undefined
  const ok = survives === "running" && evictedOldestTerminal
  A.ok(ok, "H6 trim mismatch running=" + survives + " t0=" + L.get("t0"))
  rec("H6", "trim evicts terminal records before running ones",
    `after 101 records (100 terminal + 1 running): running record state=${survives}, oldest terminal t0 evicted=${evictedOldestTerminal}`,
    ok, "ConsultLedger.trim() filters terminal records first, insertion order breaks ties")
}

// ---------------------------------------------------------------- H10 failure framing
{
  const cases = [
    new Error("upstream 401 unauthorized: sk-live-SECRET123"),
    new Error("rate limit 429 from https://api.example.com/v1/chat"),
    "plain string failure with token abcdef",
    { weird: true },
  ]
  const out = cases.map((c) => redactError(c instanceof Error ? c.message : String(c)))
  const noSecret = out.every((s) => !/sk-live-SECRET123/.test(s))
  const allStrings = out.every((s) => typeof s === "string" && s.length > 0)
  const noStack = out.every((s) => !/\n\s+at /.test(s))
  A.ok(noSecret && allStrings && noStack, "H10 framing " + JSON.stringify(out))
  rec("H10", "every failure path returns framed text, never a raw exception",
    `redactError() over ${cases.length} hostile inputs -> all strings=${allStrings}, secret stripped=${noSecret}, no stack traces=${noStack}`,
    noSecret && allStrings && noStack, out.map((s) => JSON.stringify(s)).join(" | "))
}

// ---------------------------------------------------------------- G1 replaceSystemInBody
{
  const mk = (b) => JSON.stringify(b)
  const chat = { messages: [{ role: "user", content: "hi" }], system: [{ type: "text", text: "ORIGINAL SYSTEM" }], tools: [{ name: "bash" }] }
  const r1 = replaceSystemInBody(mk(chat), ["INJECTED BLOCK"], "MARKER123")
  const out = JSON.parse(r1.body)
  const injected = r1.format === "anthropic" && JSON.stringify(out).includes("INJECTED BLOCK") && JSON.stringify(out).includes("MARKER123")
  const keptOriginal = JSON.stringify(out).includes("ORIGINAL SYSTEM")
  // idempotence: a second pass with the same marker must be a no-op
  const r2 = replaceSystemInBody(r1.body, ["INJECTED BLOCK"], "MARKER123")
  // chat format (no system key): leading system message is unshifted
  const r3 = replaceSystemInBody(mk({ messages: [{ role: "user", content: "hi" }] }), ["INJECTED BLOCK"], "MARKER999")
  const chatOut = JSON.parse(r3.body)
  const lead = chatOut.messages[0]
  // chat format WITH an existing system message: appended as a TRAILING system
  // message (late instruction is the most salient safe channel)
  const r4 = replaceSystemInBody(
    mk({ messages: [{ role: "system", content: "S1" }, { role: "system", content: "S2" }, { role: "user", content: "hi" }] }),
    ["INJECTED BLOCK"], "MARKER777")
  const r4Out = JSON.parse(r4.body)
  const tail = r4Out.messages[r4Out.messages.length - 1]
  const ok = injected && keptOriginal && r2 === undefined &&
    r3.format === "chat" && lead.role === "system" && lead.content.includes("INJECTED BLOCK") &&
    r4.format === "chat" && tail.role === "system" && tail.content.includes("INJECTED BLOCK") &&
    r4Out.messages.length === 4
  A.ok(ok, "G1b injection " + JSON.stringify({ f1: r1.format, idem: r2, f3: r3.format, lead: lead?.role, f4: r4.format, tail: tail?.role }))
  rec("G1b", "injection lands in the system channel with a fresh per-batch marker, and is idempotent",
    `anthropic-body: format=${r1.format} originalSystemPreserved=${keptOriginal} injected=${injected}; ` +
    `same-marker re-pass returned undefined (idempotent)=${r2 === undefined}; chat-body (no system key): format=${r3.format} ` +
    `system message UNSHIFTed to index 0 role=${lead.role}; chat-body (system msgs present): format=${r4.format} ` +
    `system message APPENDED as trailing (${r4Out.messages.length} msgs total) role=${tail.role}`,
    ok, "replaceSystemInBody handles responses/anthropic/chat; marker is per-batch random so a stale sentinel cannot suppress injection")
}

console.log("=== A6 + G + H (free) ===")
for (const r of R) {
  console.log(`\n[${r.verdict}] ${r.id}  expected: ${r.expected}`)
  console.log(`   observed: ${r.observed}`)
  console.log(`   evidence: ${r.evidence}`)
}
const fails = R.filter((r) => r.verdict === "FAIL")
console.log(`\nSUMMARY GH: pass=${R.length - fails.length} fail=${fails.length}`)
process.exit(fails.length ? 1 : 0)
