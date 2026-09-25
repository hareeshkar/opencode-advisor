# opencode-advisor — Correctness & Code Quality Review

Scope: `src/types.ts`, `src/options.ts`, `src/prompts.ts`, `src/pruner.ts`, `src/engine.ts`,
`src/v2.ts`, `src/v1.ts`, `src/providers.ts`, `src/index.ts`, `test/pruner.test.mjs`,
`test/engine.test.mjs`.

Ground truth used to falsify/confirm shape assumptions:
`research/api-types/API_SURFACE_REFERENCE.md` (extracted `@opencode/plugin@2.0.16`,
`@opencode/ai@2.0.16`, `@opencode/client@2.0.16`) and `research/docs-scrape/v2/openapi.json`.

All 18 tests currently pass (`npm test`), which is itself evidence for several TEST GAPS below.
Severity: **CRITICAL** would break users · **MAJOR** wrong behavior in realistic cases ·
**MINOR** polish · **TEST GAPS**.

---

## CRITICAL

### C1 — V2 tool evidence is never extracted; advisor gets tool *input* or a JSON prologue, and loses tail errors
`src/v2.ts:29-64` (helpers), `src/v2.ts:86-89` (call site)

`toolSlice()` feeds `state` through `toText()`, but the real V2 shape for an assistant tool part
(`Session.Message.Assistant.Tool`) is:

```ts
state: {
  status: "completed" | "error" | "running" | "streaming",
  input: object,
  content?: Array<{ type: "text"; text: string } | { type: "file"; uri; mime }>,
  error?: { type; message; status? }
}
```

There is **no `output` field**. `toText()` has two holes that make the tool path wrong:

1. It does not handle a bare array (`src/v2.ts:29-41`): for `v = [{type:"text",text:"..."}]`,
   no key in `["text","output","content","result","data"]` is `in` an array, and the
   `Array.isArray(rec.content)` branch tests `rec.content` on the array itself, so it returns `""`.
   Therefore `toText(state.content)` is always `""`.
2. Its key list includes `input` (line 49), and `toText(state.input)` recurses over
   `["text","output","content","result","data"]`. For tools whose args carry such a field
   (`write`/`edit` have `content`/`newString`; many have `text`), `toText(state.input)` returns the
   **tool input** as if it were the tool output. Verified reproduction:

```
toolSlice("read", {type:"tool",name:"read",state:{status:"completed",
  input:{filePath:"/x.ts",limit:50},
  content:[{type:"text",text:"REAL_FAILING_TEST_OUTPUT: expected 1 got 2"}]}})
→ {"role":"tool","name":"read","text":"{\"status\":\"completed\",\"input\":{\"filePath\":\"/x.ts\"...}"}
// i.e. JSON.stringify(state).slice(0,400), not the tool output
```

Consequences in realistic cases:
- Every tool result becomes at most a **400-char JSON prologue**, so for large outputs the advisor
  never sees the tail where errors live — directly defeating pruner design goal #4.
- Tool args can be misreported as tool output.
- The resulting text is JSON, so `NOISE_PATTERNS` and `truncateMiddle` never operate on tool output in
  V2; the 1,500-char tool cap is bypassed.

This silently corrupts the evidence given to the advisor on the **verified path**, which is the
product's core function.

**Fix** (handle arrays, prefer real output fields, add `error`, stop treating `input` as output):

```ts
function toText(v: unknown, depth = 0): string {
  if (typeof v === "string") return v
  if (v === null || v === undefined || depth > 2) return ""
  if (Array.isArray(v)) return v.map((c) => toText(c, depth + 1)).filter(Boolean).join("\n")
  if (typeof v !== "object") return ""
  const rec = v as Record<string, unknown>
  for (const key of ["text", "output", "content", "result", "data"]) {
    const s = toText(rec[key], depth + 1)
    if (s) return s
  }
  return ""
}

function toolSlice(name: unknown, part: unknown): Slice | undefined {
  const st = (part as { state?: Record<string, unknown> })?.state
  const label = typeof name === "string" ? name : "unknown"
  if (!st || typeof st !== "object") return undefined
  const parts: string[] = []
  if (typeof st.error === "object" && st.error) {
    const e = st.error as { message?: unknown }
    if (typeof e.message === "string") parts.push(e.message)
  }
  const out = toText(st.content)                     // now handles arrays of {type,text}
  if (out) parts.push(out)
  if (parts.length) return { role: "tool", name: label, text: parts.join("\n") }
  // fallback: bounded JSON, but never pretend args are the result
  try {
    const json = JSON.stringify(st)
    if (json && json !== "{}" && json !== "null") return { role: "tool", name: label, text: json.slice(0, 400) }
  } catch { /* circular — drop */ }
  return undefined
}
```

---

## MAJOR

### M1 — `resetTask` replaces the per-session state object; in-flight `consult` writes to an orphan
`src/engine.ts:100-102` (reset), `132-141`/`183` (consult), `115-116` (noteStep)

`resetTask` does `this.tasks.set(sessionID, {…new object…})`, but an in-flight `consult()` captured
`const st = this.state(sessionID)` (line 133) before the reset. On completion it sets
`st.advisorUsed = true` (line 183) on the **old** object, which is no longer in the Map. Realistic
without a fresh prompt: user interrupts/steers a turn (`prompt` hook fires → `resetTask`) while the
advisor sub-call is running. Result: the new state reports `advisorUsed = false`, so a later nudge
can fire after the advisor was already used, and the old call's cap increment and `advisorUsed` are
lost. The same orphan bug applies to any in-flight `noteStep` reference.

**Fix** — keep one stable object per session and reset its fields:

```ts
resetTask(sessionID: string): void {
  const st = this.state(sessionID)
  st.calls = 0
  st.steps = 0
  st.advisorUsed = false
  st.nudged = false
  st.lastSeen = Date.now()
}
```

(Optionally guard `st` identity in `consult` when setting `advisorUsed`.)

### M2 — Hook/tool registrations are never disposed; reload duplicates hooks and tools
`src/v2.ts:176-199, 202-209, 212-231, 246`

`ctx.tool.transform`, `ctx.session.hook("prompt", …)` and `ctx.session.hook("context", …)` each
return a `Registration` (`API_SURFACE_REFERENCE.md:1.10` / `registration.d.ts`) that must be
disposed on plugin unload. The code discards all three, and the returned `Cleanup` only logs
(`src/v2.ts:246`). On plugin reload this leaks registrations and, because hook callbacks accumulate,
can cause the timing prompt and nudge to fire repeatedly.

**Fix**:

```ts
const regs: { dispose(): Promise<void> }[] = []
// ... regs.push(await ctx.tool.transform(cb));  regs.push(await ctx.session.hook("prompt", cb)); etc.
return async () => {
  await Promise.allSettled(regs.map((r) => r.dispose()))
  log("info", `unloaded v${PLUGIN_VERSION}`)
}
```

### M3 — Pruner can exceed `transcriptBudgetChars`: `used` omits join separators and pin evicts only one line
`src/pruner.ts:105-128`

Two defects:
1. `used` counts only line lengths, but the output is `lines.join("\n\n")`, adding `2*(n-1)` chars
   that are never budgeted.
2. Pass 3 evicts at most **one** line (`lines.shift()`), then unconditionally unshifts a pinned line
   up to `min(body.length, 2000)` chars (body is pre-truncated to `maxToolOutputChars*2`). If the
   evicted line is short (e.g. an assistant `"ok"`), the pinned line can push the output well over
   budget. Measured against `dist/`: `maxToolOutputChars:200, transcriptBudgetChars:800` with a
   3,000-char original task and one tiny oldest line produced `outChars = 958` (**158 over**, ~20%).

This violates the file's stated priority #1 ("Never exceed the char budget").

**Fix**:

```ts
const SEP = 2
let used = 0
// in pass 2, when adding a line: account for the separator if lines.length > 0
if (used + line.length + (lines.length ? SEP : 0) <= budget || lines.length === 0) {
  used += line.length + (lines.length ? SEP : 0)
  lines.unshift(line)
}
// pass 3
const maxPin = 2_000
let pinned = `[original task] ${truncateMiddle(firstUser.body, Math.min(firstUser.body.length, maxPin))}`
while (lines.length > 1 && used + pinned.length + SEP > budget) {
  const ev = lines.shift()!
  used -= ev.length + SEP
  // NOTE: do not increment `dropped` here — this slice was already counted in pass 2
}
if (used + pinned.length > budget) pinned = truncateMiddle(pinned, Math.max(80, budget - used))
lines.unshift(pinned); used += pinned.length
// final: assert used <= budget in tests
```

### M4 — Nudge fires only at exactly `step === 1`; extra hook invocations make it never fire
`src/engine.ts:115-129`

`noteStep` is driven by the V2 `context` hook. It nudges only when `step === 1` and never sets a
"not eligible" sentinel. If the `context` hook is invoked more than once before the executor's
second real model turn (re-run after a transform, a retried request, or a request that produces no
tool/assistant step), `steps` advances past 1 and the nudge is permanently skipped for that task.
Conversely, timing is keyed on `step === 0`, so extra invocations only ever consume the slot.

**Fix** — make both events monotonic:

```ts
const step = st.steps++
const injectTiming = this.opts.injectTimingPrompt && !st.timingInjected && step >= 0
if (injectTiming) st.timingInjected = true
const NUDGE_AT = 1
const injectNudge = !st.nudged && !st.advisorUsed && step >= NUDGE_AT && nudgeEligible &&
  (this.opts.nudge === "on" || this.opts.nudge === "auto")
if (injectNudge) st.nudged = true
```

(Add `timingInjected`/`nudged` to `TaskState`; `resetTask` clears them — see M1 for in-place reset.)

### M5 — Failed/timed-out attempts consume the per-task cap
`src/engine.ts:134-141, 145-154, 161-167`

`st.calls++` happens before any work and is never rolled back. A single slow advisor (default
`timeoutMs` 90 s) or three transient failures permanently returns `max_uses_exceeded` for the rest of
the task, even though the executor never received advice. In realistic flaky-provider conditions the
advisor becomes unusable for the task.

**Fix** — count only delivered advice, or track attempts and successes separately:

```ts
if (st.calls >= this.opts.maxUsesPerTask) return { ok: false, errorCode: "max_uses_exceeded", ... }
// ... after successful hardCapWords ...
st.calls++
```

If a loop guard is still wanted, add a separate `attempts` counter with a higher bound and keep it
out of the user-facing message.

### M6 — V1 transcript fetch: optional chaining + `.catch` throws when the method is absent; `?? []` is dead
`src/v1.ts:122-124`

```ts
const messages = await (client.session.messages?.({ path: { id: sessionID } }).catch(() =>
  client.session.messages?.({ query: { sessionID } }),
) ?? [])
```

- `.catch` is applied to the **result** of `client.session.messages?.(…)`. If `messages` is
  `undefined` (SDK rename/version mismatch, or a partially initialized client), this is
  `undefined.catch(...)` → `TypeError`, which the engine turns into a misleading `unavailable`.
- `?? []` can never trigger because a Promise is never nullish (the `.catch(...)` result is always a
  Promise; if the method is absent it throws before this point).

**Fix**:

```ts
getTranscript: async (sessionID) => {
  const m = ctx?.client?.session?.messages
  if (typeof m !== "function") throw new Error("v1 host has no session.messages")
  let messages: unknown = []
  try { messages = await m({ path: { id: sessionID } }) }
  catch { messages = await m({ query: { sessionID } }) }
  return normalizeV1Messages(messages)
}
```

### M7 — V1 system transform ignores the sessionID/model the SDK actually provides
`src/v1.ts:152-156`

`Hooks["experimental.chat.system.transform"]` receives
`(input: { sessionID?: string; model: Model }, output: { system: string[] })`
(`API_SURFACE_REFERENCE.md:1010-1013`). The handler ignores `input` entirely and keys all state under
`"*"`, so per-task caps degrade to per-session even when `sessionID` is available, and the nudge is
never eligible in the default `"auto"` mode because `shouldNudgeExecutor(undefined, …)` is always
false.

**Fix**:

```ts
"experimental.chat.system.transform": async (inp: { sessionID?: string; model?: any }, output: { system: string[] }) => {
  const sid = inp?.sessionID ?? "*"
  const m = inp?.model
  const modelId = m ? `${m.providerID ?? m.provider ?? ""}/${m.id ?? m.modelID ?? ""}` : undefined
  const d = engine.noteStep(sid, modelId, shouldNudgeExecutor(modelId, opts.nudge))
  ...
}
```

### M8 — V1 usage persistence is a non-serialized read-modify-write; concurrent consults drop entries
`src/v1.ts:32-52, 136`

`persistUsageFile` reads `usage.json`, merges, writes. Two concurrent `consult()` calls (the executor
can call the advisor tool in parallel rounds; also V2 does not serialize V1) interleave and the
second write clobbers the first — lost usage. V2 handles this with `usageChain` (`src/v2.ts:133-154`);
V1 does not. Writes are also not atomic (partial writes on crash).

**Fix** — serialize like V2 (module-level chain) and/or write to a temp file + `rename`:

```ts
let usageChain: Promise<void> = Promise.resolve()
function persistUsageFile(entry: UsageEntry): Promise<void> {
  usageChain = usageChain.then(async () => { /* read-merge-write, tmp+rename */ }).catch(() => {})
  return usageChain
}
```

### M9 — Provider retry is effectively dead because it shares the engine's timeout; backoff ignores abort
`src/providers.ts:80-96` vs `src/engine.ts:34-56, 162`

`callWithRetry` allows two attempts, each with the full `timeoutMs`, plus a 1,500 ms sleep — so a
retry only exists if attempt 1 finished in under `timeoutMs - 1500`. But the engine wraps the same
call in `withTimeout(…, this.opts.timeoutMs, …)`, so the engine rejects at `timeoutMs`; on a slow 429
the retry never runs. The backoff `await new Promise(r => setTimeout(r, 1500))` also does not observe
`signal`, so an abort waits out the backoff before the (immediately-aborting) second attempt.

**Fix** — one timeout owner (engine), and pass the remaining budget:

```ts
// engine: runAdvisor receives signal; providers should not re-implement the wall clock.
async function sleep(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")) }
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
```

---

## MINOR

- **m1** `src/v2.ts:129` — `logLevel` cannot silence `info`: `opts.logLevel === "debug" || level === "info"`
  always logs info, even when `logLevel: "error"`. Fix:
  `const show = level === "error" || level === "warn" || (level === "info" && (opts.logLevel === "info" || opts.logLevel === "debug")) || (level === "debug" && opts.logLevel === "debug")`.
- **m2** `src/prompts.ts:61-66` — `transcriptHeader()` is exported but never called (confirmed by
  grep), so the advisor is never told the transcript was pruned, contradicting the file's own design
  note. Either call it in `buildAdvisorPrompt` or delete it; if called, its length must join the
  budget accounting (M3).
- **m3** `src/engine.ts:104-106` — `markAdvisorUsed()` is dead; `noteStep`'s `executorModelId`
  parameter is unused (`void executorModelId`, line 127). Remove or use.
- **m4** `src/pruner.ts:98` — `keepFull` is computed (`s.role === "user"`) but never used to bypass
  truncation; a long user task is truncated to `maxToolOutputChars*2` like any slice, then possibly
  re-truncated in pass 3. Either use it or drop the field.
- **m5** `src/options.ts:171` — `FRONTIER` includes `max`, so `minimax-*` executors are classified
  frontier and never nudged in `auto`; `o[1-9]\b` misses `o10+`. Tighten to token-aware patterns.
- **m6** `src/engine.ts:18-31` — `hardCapWords` appends `" …[truncated]"` and then counts it as a
  word in the `parts.length > words` branch, so output can be `words + 1` words and, in edge cases,
  carry two markers. Reserve one word for the marker or append after counting.
- **m7** `src/engine.ts:164` — the timeout/error path records `tokensIn = 0` even though `promptChars`
  is known (line 158); `getTranscript` failures (147-150) record nothing at all. Inconsistent
  accounting.
- **m8** `src/index.ts:17` and `src/providers.ts:17` — version `"0.1.0"` / user-agent hardcoded
  separately from `PLUGIN_VERSION` (`src/types.ts:10`). Use the constant.
- **m9** `src/v1.ts:137-140` — V1 `log` ignores `logLevel` and prints every info message.
- **m10** `src/engine.ts:85-91` — LRU eviction at `MAX_TRACKED_SESSIONS = 512` silently resets a live
  session's cap/step state, allowing more than `maxUsesPerTask` calls.
- **m11** `src/providers.ts:97` — the final `throw new Error(...lastErr...)` is unreachable: the loop
  body either returns or throws on both attempts.
- **m12** `src/v2.ts:75` — `toText(msg.content) ?? toText(msg.parts)` is misleading: `toText` returns
  `""` (never `null`/`undefined`), so `??` never fires and `parts` is dead (V2 has no `parts`). Use
  `||` or restructure.

---

## TEST GAPS

- **T1** No tests for `normalizeV2Transcript`/`toolSlice` at all (they are not exported from
  `src/index.ts`, so they cannot be exercised from the tests either). This is the single biggest gap:
  the C1 bug (tool input returned as output; tool content dropped) is completely uncovered. Export the
  normalizer and add fixtures modelled on real `Session.Message.*` shapes from `openapi.json`
  (`Assistant.Tool` with `content[]` and with `error`, `User` with `text`, `Synthetic`, `Shell`).
- **T2** `test/pruner.test.mjs:13-14` asserts `<= budget + 200`, which is loose enough to pass despite
  the M3 overflow. Assert the documented invariant (`outChars <= transcriptBudgetChars`) and add a
  case with a long original task plus a tiny oldest assembled line (the reproducer in M3).
- **T3** No test that a user-pasted npm/build log survives (`isNoise` is only applied to role `tool`,
  `src/pruner.ts:92`), and no boundary test for `NOISE_LINE_THRESHOLD = 0.6`. Add both, plus a
  false-positive case (a legitimate quote/diff output that is `> `-heavy).
- **T4** `test/engine.test.mjs:35-44` is named "…advisorUsed set" but never inspects `advisorUsed`; the
  usage assertion depends on `recordUsage` doing a synchronous `usage.push` before the microtask
  boundary (`src/engine.ts:184` fire-and-forget). Make `persistUsage` deferred and await a flush, or
  assert `advisorUsed` directly.
- **T5** No concurrency tests: concurrent `consults` against the cap, V2 serialized usage writes, and
  the M1 `resetTask`-during-inflight-consult race.
- **T6** No tests for `providers.ts` (URL join `/v1` vs bare base, 429 retry, timeout vs host signal,
  Anthropic multi-block extraction, non-JSON body) or `options.ts` (`shouldNudgeExecutor` tiers, env
  precedence, invalid-option throws) or `noteStep` default `auto` gating.
- **T7** `test/engine.test.mjs:65-73` leaves a 500 ms pending timer; `100-107` tolerates `<= 55` words
  for a 50-word budget, masking the extra marker word (m6).

---

### Counts
- CRITICAL: 1
- MAJOR: 9
- MINOR: 12
- TEST GAPS: 7
