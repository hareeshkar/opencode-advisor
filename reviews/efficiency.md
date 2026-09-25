# opencode-advisor — Performance & Cost-Efficiency Review

Scope: `src/pruner.ts`, `src/engine.ts`, `src/prompts.ts`, `src/options.ts`, `src/v2.ts`, `test/pruner.test.mjs`.
Method: static trace + byte-accurate measurement of the prompt assets against the built bundle, plus microbenchmarks of `pruneTranscript` at 500-slice / 100k-line scale. Token counts use the repo's own `chars/4` heuristic (English prose ≈ 3.8–4.1 chars/token, so estimates are within ~±5%).

Priorities: **hot-path** = paid on every model call of a task · **per-consult** = paid only when `advisor` is invoked · **cold** = setup / lifecycle / rare.

---

## F1 — `ADVISOR_TOOL_DESCRIPTION` is 416 tokens on every single model call; comment claims ~70 (6× undercount)

- **Location:** `src/prompts.ts:12-20`, consumed at `src/v2.ts:179`.
- **Measured:** the joined string is **1,662 chars ≈ 416 tokens / 257 words**. The JSDoc says "~70 tokens". Because it is a registered **tool description**, the host sends it in the tool catalog on *every* model request, not once per task.
- **Cost:** a task with `C` model calls pays `416 × C`. For a typical `C = 8` agent loop that is **~3,328 tokens per task** — ~91% of the plugin's entire unavoidable executor-side overhead. `C = 20` ⇒ ~8,320 tokens.
- **Fix:** cut to a single imperative sentence (~15–20 words, ~30 tokens), e.g.
  `Consult a stronger reviewer model before committing to an approach and before declaring done. No parameters; the conversation is forwarded automatically. Treat its advice as strong guidance.`
  That recovers ~380 tokens/call. Only register the tool after the first step if the host supports conditional catalog mutation; otherwise this is the single highest-leverage edit in the plugin.
- **PRIORITY: hot-path (highest impact).**

## F2 — Timing-prompt gating is *not* airtight: under-injection, double-injection, and a silently consumed step

- **Location:** `src/engine.ts:115-129` (`noteStep`), `src/v2.ts:202-231` (prompt + context hooks).
- **Trace:** `resetTask` fires on the host `prompt` hook; `noteStep` fires on every `context` hook (per model call), increments `st.steps`, and injects only when `step === 0`.
- **Holes:**
  1. **Prompt hook failure = per-session, not per-task.** `v2.ts:207-209` catches registration failure and *continues* (log warn, "caps degrade to per-session"). `engine.ts` then never resets `steps`, so timing is injected on the **first call of the whole session only** — every later task in that session runs with no timing guidance. Under-injection.
  2. **Any non-executor model call consumes step 0.** Title/summary/synthetic generations in the same session hit the same `context` hook; the first such hidden call receives the 283-token `EXECUTOR_TIMING_PROMPT` into *its* system prompt, and the real executor call then gets nothing (or, if `resetTask` runs afterward, gets a second copy). This is both token waste and lost signal.
  3. **Step is consumed even when injection fails.** `noteStep` increments `st.steps` before the `Array.isArray(event.system)` check at `v2.ts:219`. If `event.system` is not an array on the first call, timing is permanently lost for that task.
- **Cost:** `EXECUTOR_TIMING_PROMPT` is **1,129 chars ≈ 283 tokens** (comment claims ~150, again ~2× undercount). Multiply by the number of mis-timed tasks; the failure is asymmetric (guidance silently absent for the rest of a session).
- **Fix:** make injection *state-driven*, not *index-driven*. Have `noteStep` return `{ injectTiming, injectNudge }` where `injectTiming` is guarded by a `timingInjected` flag that is set only after the host confirms the push (return a `commitTiming()`/`commitNudge()` callback, or pass `event.system` readiness into the decision). Reset `timingInjected`/`nudged` in `resetTask`, and key the task state on an explicit user-turn id rather than relying on the prompt hook having registered. On prompt-hook registration failure, re-register or fall back to detecting the first `[original task]` user slice.
- **PRIORITY: hot-path (correctness + up to 283 tokens/task).**

## F3 — Context hook does avoidable work per model call; nudge eligibility computed after it can no longer matter

- **Location:** `src/v2.ts:213-228`, `src/engine.ts:82-97`.
- **Measured:** per call the hook allocates 2–3 strings, calls `Date.now()` twice inside `state()`, does a Map get+set, and runs `shouldNudgeExecutor` (two `RegExp.test`s) even when `st.nudged || st.advisorUsed` is already true. Cost ~1–2 µs/call — negligible in absolute terms, but it is pure overhead on the executor's critical path and it is trivially removable.
- **Fix:** early-out in `v2.ts` before computing eligibility: `if (!d-needed) skip nudge calc`. Compute `shouldNudgeExecutor` lazily inside `noteStep` only when `step === NUDGE_STEP && !nudged && !advisorUsed`. Also cache the resolved model-id string per model ref if the hook is called many times.
- **PRIORITY: hot-path (low absolute cost).**

## F4 — `lines.unshift()` in the assembly loop is O(n²)

- **Location:** `src/pruner.ts:105-114` (and the one-off `lines.shift()` at `:122`).
- **Measured:** `unshift` re-indexes the array each iteration. Benchmark of 20,000 tiny slices → **25.5 ms**. Under a realistic budget, `n` is capped at `budget / min-line-len`; with `[tool:read] z` (~13 chars) and a 48,000-char budget, `n ≈ 3,700` ⇒ ~5 ms. At 500 conventional slices we measured **2.7 ms** total, so today it is not a crisis — but the file's header claims "single-pass, O(total chars)", which this violates.
- **Fix:** assemble into a `const out: string[] = []` with `out.push(line)` while iterating newest→oldest, then `out.reverse().join("\n\n")`. O(n). Pass 3's `shift()` becomes a `pop()`/`unshift()` on the small tail slice, or use a two-part array (pinned header + body).
- **PRIORITY: per-consult.**

## F5 — `isNoise` splits every tool body and runs 6 regexes per line; regexes are safe (no catastrophic backtracking)

- **Location:** `src/pruner.ts:21-52` (`NOISE_PATTERNS`, `isNoise`), `:17-18` (`ANSI`, `WHITESPACE_RUNS`).
- **Backtracking analysis (requested):** all patterns are linear.
  - `ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g` — fixed `\x1b[` anchor; the two quantifiers consume **disjoint** character classes (`[0-9;?]` vs `[ -/]`), so there is no ambiguous split and no super-linear backtracking.
  - `WHITESPACE_RUNS = /\n{3,}/g` — single-class counter, linear.
  - Progress bar `/…[^|\n]{0,60}…/` — **bounded** quantifier, the correct defensive choice.
  - `^\s*(…)/m` patterns are `.test()`ed **per line**, so with no interior `\n` the `^` can only match at index 0; `\s*` cannot run away. Linear.
  - No nested unbounded quantifiers anywhere ⇒ **no catastrophic backtracking**.
- **Measured:** `clean()` does two full global regex passes over every slice; `isNoise` then `split("\n")` (allocates one string per line) + up to 6 tests/line for tool slices. 500 slices × 200 lines = 100k lines → **18.6 ms**. Decode of a 1 MB transcript → 2.7 ms. Acceptable for a per-consult path.
- **Fix (optional):** avoid the `split("\n")` allocation with an index scan (`indexOf("\n")`), and short-circuit `isNoise` once `hits / lines < THRESHOLD` becomes arithmetically unreachable. Also skip `clean()`/`isNoise` for `role !== "tool"` where only length matters — user/assistant slices rarely contain npm noise.
- **PRIORITY: per-consult (measured acceptable; optimization only).**

## F6 — Pin-detection recomputes `firstUser.body.slice(0, 40)` per line

- **Location:** `src/pruner.ts:117-118`.
- **Cost:** `lines.some(l => … l.includes(firstUser.body.slice(0,40)))` allocates the 40-char prefix once **per line**. At `n ≈ 3,700` that is ~3,700 redundant 40-char allocations + substring searches, plus `startsWith("[user]")` and `includes`. Sub-millisecond, but sloppy.
- **Fix:** hoist `const needle = firstUser.body.slice(0, 40)` above the `.some()`, and track whether the first user slice was kept during Pass 2 (a boolean) instead of re-searching strings.
- **PRIORITY: per-consult (nit).**

## F7 — `transcriptHeader()` is dead code; the advisor never receives the pruning manifest

- **Location:** `src/prompts.ts:36-58` (`buildAdvisorPrompt`), `src/prompts.ts:60-66` (`transcriptHeader`).
- **Finding:** `grep` across `src/` and `test/` shows `transcriptHeader` has **no call site** — only its definition. `buildAdvisorPrompt` joins its own inline framing and never invokes it. The `PruneStats` (`droppedSlices`, `truncatedSlices`) that the header was designed to summarize are computed in `pruner.ts` and then discarded for prompt purposes.
- **Cost:** either (a) ~0 tokens but a real capability loss — the advisor cannot tell an aggressively pruned transcript (many slices dropped) from a complete one, so it cannot caveat its advice; or (b) if wired in, ~40–50 tokens per consult.
- **Fix:** decide. I recommend wiring it in — the signal value ("most recent kept; original task pinned; N dropped/truncated") is high relative to ~45 tokens, and it directly serves the "smallest **high-signal** context" goal. Otherwise delete the function so it isn't mistaken for active behavior.
- **PRIORITY: cold (design decision).**

## F8 — `resetTask` bypasses the 512-session eviction, so the task Map can grow unbounded

- **Location:** `src/engine.ts:85-97` (`state()` eviction) vs `:99-102` (`resetTask`).
- **Finding:** eviction runs **only** in `state()`. `resetTask` does `this.tasks.set(sessionID, …)` with no cap check. Because the V2 `prompt` hook calls `resetTask` for every admitted prompt, a host with many short sessions (or many one-shot sessions) inserts an entry per session with **no** eviction, and `state()` only evicts one entry per *new* session it later sees. The Map can grow well past 512 and stay there — a genuine unbounded-growth leak, contradicting the `MAX_TRACKED_SESSIONS = 512` intent.
- **Cost:** each `TaskState` is ~5 fields (~100–200 B); 10k sessions ≈ 1–2 MB retained for plugin lifetime, plus a growing O(size) eviction scan on every new session once over cap.
- **Fix:** extract `private evictIfNeeded(): void` from `state()` and call it in `resetTask` too. Cheaper still: bound with an LRU (a `Map` in insertion order + `delete`/`set` on touch) so the scan is O(1) amortized instead of O(size).
- **PRIORITY: cold (memory safety / leak).**

## F9 — Usage ledger does a serialized read-modify-write per consult (write amplification)

- **Location:** `src/v2.ts:135-154` (`persistUsage`), called from `engine.ts:164/171/184` via `recordUsage` (`engine.ts:194-210`).
- **Finding:** each consult enqueues `storage.get("usage:<date>")` + `storage.set(...)` on the `usageChain`. It is fire-and-forget (`recordUsage(...).catch(()=>{})`), so the executor hot path is **not** blocked — confirmed good. But N consults = 2N sequential storage round-trips against a single key, and any entry still queued when the process unloads is lost (the chain has no `onDispose` drain).
- **Cost:** per-consult only (≤ `maxUsesPerTask`, default 3). Read/write amplification is bounded but avoidable.
- **Fix:** keep a process-local `Map<date, UsageEntry>` accumulator and flush on an interval / on `dispose` / every N consults; or coalesce all queued entries by date before a single `set`. Also drain `usageChain` in the returned unload function at `v2.ts:246`.
- **PRIORITY: per-consult (low; durability nit).**

## F10 — `prepared[]` retention and the redundant `inChars` pass (acceptable, note only)

- **Location:** `src/pruner.ts:81` (`slices.reduce` length pass), `:88-99` (`prepared`).
- **Cost:** `prepared` holds cleaned/truncated copies of every surviving slice. Worst case ≈ `slices × cap`; at 500 tool slices × 1,500 chars ≈ **750 KB** transient per consult, GC'd after return. The `inChars` reduce is an extra full pass over the slice array (not the string bytes). Both are fine.
- **Fix:** none required. If memory ever matters, stream Pass 2 directly off `slices` and fold `inChars` into the Pass-1 loop.
- **PRIORITY: cold (informational).**

---

## Token budget ledger — plugin's own overhead per task

Model: a task = one user turn + `C` executor model calls; executor pays every token below on **every** call unless marked once-per-task. Advisor tokens are billed to the advisor model on the ≤ `maxUsesPerTask` (default 3) sub-calls.

### A. Executor-side overhead (`chars/4`; measured from built assets)

| Asset | Chars | Est. tokens | Frequency | Cost per task |
|---|---:|---:|---|---:|
| `ADVISOR_TOOL_DESCRIPTION` | 1,662 | **~416** | **every model call** | `416 × C` |
| `EXECUTOR_TIMING_PROMPT` | 1,129 | **~283** | once/task (if gating holds) | ~283 |
| `NUDGE_TEXT` | 182 | **~46** | once/task, small-tier only | 0 or ~46 |

**Per-task overhead = 416·C + 283 + (46 if nudged).**

- `C = 4` → 1,664 + 329 = **~1,993 tok** (tool desc = 84%)
- `C = 8` (typical) → 3,328 + 329 = **~3,657 tok** (tool desc = **91%**)
- `C = 20` → 8,320 + 329 = **~8,649 tok** (tool desc = 96%)

The tool description alone dwarfs the timing prompt by ~1.5× *per call* and, being per-call, dominates the entire overhead. **F1 is the fix that matters.**

### B. Advisor-side cost (per consult; advisor model pays)

| Component | Chars | Est. tokens |
|---|---:|---:|
| Fixed framing (`buildAdvisorPrompt` minus transcript) | 814 | ~204 |
| Transcript (budget default `transcriptBudgetChars`) | ≤ 48,000 | ≤ ~12,000 |
| Observed transcript at 500 slices | 47,972 | ~11,993 |
| Advisory output (prompt + `hardCapWords`, 120-word budget) | — | ~160 out |

One consult ≈ **~12.2k tokens in / ~0.16k out**; 3 consults ≈ up to **~36.6k in**. This dominates *total* plugin token spend but is the intended work product and is bounded by `transcriptBudgetChars` (the 48k default is generous — dropping to ~24k halves advisor cost with little signal loss for most tasks).

### C. Injection-count sanity

- Timing prompt: intended **1/task**. With F2's holes it is **0/task** (prompt-hook failure), **0 or 2/task** (hidden model call racing `resetTask`), or **1/task** (happy path). Gating is not airtight.
- Tool description: **1× per call**, guaranteed on.
- Nudge: intended **1/task** for small-tier and **0** otherwise; correctly latched by `st.nudged`.

### D. Bottom line

1. **Shrink the tool description (F1)** — recovers ~380 tokens × every call; the largest single lever by far.
2. **Make timing/nudge injection state-driven (F2)** — closes the under/double-injection window around a 283-token asset.
3. Cost-optimal default would be `transcriptBudgetChars ≈ 24k` and a ~30-token tool description: per-consult advisor input roughly halves and per-call executor overhead drops ~90%.

Microbenchmark summary (this machine): 500 slices / 1.03 MB → 2.7 ms prune; 100k lines → 18.6 ms; 20k tiny lines → 25.5 ms (`unshift` O(n²)). No pathological regex behavior found.
