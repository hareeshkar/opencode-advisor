# Regression v0.7.1 — PARTIAL (aborted)

**Date:** 2026-09-26
**Session:** `ses_f22cff730ffeAjSUM6PQn5gn47`
**Build under test:** `dist/opencode-advisor.js` (reloaded to `~/.config/opencode/opencode-advisor/index.js`)
**Status:** PARTIAL — aborted after L2 of 6 paid scenarios.

> **ABORTED BY USER — timeout semantics being redesigned (v0.8.0); regression to be re-run after deploy**

---

## 1. Scenario matrix

### Tier 1 — free pipeline/invariant checks (node import of `dist/`, transcript replay of 722 msgs)

| ID | Expected | Observed | Verdict | Evidence |
|----|----------|----------|---------|----------|
| R1 | Evidence contains no `ADVISOR REVIEW by ` frame | Raw check: `frames found: 2, slices=1232, evidenceChars=127985`; deep-dive: 0 full-frame slices after normalize; both hits are quoted source text of `frameAdvice(...)`, `isAdvisorOutputFrame=false` | PASS\* | \*raw script verdict was FAIL on literal substring; adjudicated PASS on the real invariant — see anomaly A1 |
| R2 | Last normalized slice is not `role=assistant` | `last slice role=user` | PASS | last slice = user text: "Input context, output context…" |
| R3 | Newest user question tail present in evidence | `tailLen=126, found=true` | PASS | tail present verbatim in pruned evidence |
| R4 | Evidence chars ≤ `transcriptBudgetChars` (128000) | `evidenceChars=127985, budget=128000` | PASS | `outChars=127985 dropped=250 truncated=32` |
| R5 | Prompt ends with STOP line + both anti-imitation rules | `endsWithStop=true rule1=true rule2=true` | PASS | `…Write your own advice now, to the executor:` |
| R6 | Pipeline run twice → identical output | `promptIdentical=true evidenceIdentical=true` | PASS | `len=130043` |
| R7 | Preset prune chars = tokens×4 (8k/16k/32k/64k → 32k/64k/128k/256k) | economy 8000/32000 ok; balanced 16000/64000 ok; thorough 32000/128000 ok; exhaustive 64000/256000 ok | PASS | all four ladder rows `ok` |
| R8 | Normalize drops tool result containing advisor frame | `slices=3 framePresent=false` | PASS | framed tool output stripped by normalize |
| R9 | Trailing strip keeps ≥1 slice, no trailing assistant draft | `slices=1 lastRole=user` | PASS | `[{role:user,…}]` |
| R10 | `isAdvisorOutputFrame` matches `frameAdvice` output, not bare quote | `match=true bareNotMatch=true` | PASS | frame detector exact |

**Tier 1: 10 PASS / 0 FAIL** (R1 with documented substring nuance, see A1).

Pipeline stats: `sliceCount=1232`, `inChars=470715`, `outChars=127985`, `droppedSlices=250`, `truncatedSlices=32`, `promptChars=130043`, `adviceTokenBudget=8000`.

### Tier 2 — paid live consults (budget: 6 `tools.advisor()` calls; **2 used, 4 never run**)

| ID | Expected | Observed | Verdict | Evidence |
|----|----------|----------|---------|----------|
| L1 | Review-mode consult returns framed advice; model-switched stays 0; ledger `calls` +1 | Sub-call timed out at default 90s; model-switched stayed **0**; ledger `errors` +1, `estTokensIn` +9799, `calls` +0 | **FAIL** | `advisor_tool_result_error: execution_time_exceeded — advisor sub-call timed out after 90000ms` |
| L2 | `advisorMode:"review-agent"` → agent-mode child consult; framed advice; model-switched stays 0 | Same 90s timeout on parent; child session `ses_f22c9b1e5ffeROl0Go1Bybiy5g` ("advisor consult") completed **server-side at 90.2s** — i.e. ~0.2s after the parent gave up; model-switched stayed **0**; ledger `errors` +1, `estTokensIn` +11265 | **FAIL** | `advisor_tool_result_error: execution_time_exceeded — advisor sub-call timed out after 90000ms` |
| L3 | Review consult returns framed advice; `calls` +1 | — | NOT RUN | aborted per stop order |
| L4 | `{}` config → setup message (`/advisor-settings`, "ONLY required step"); ledger delta 0 | — | NOT RUN | aborted per stop order |
| L5 | `"preset":"economy"` → smaller prompt budget | — | NOT RUN | aborted per stop order |
| L6 | Byte-exact baseline config + final consult | — | NOT RUN | aborted per stop order |

**Tier 2: 0 PASS / 2 FAIL / 4 not run.**

Sub-assertions that did hold for L1/L2:
- **zero new `model-switched` tool events** for `ses_f22cff730ffeAjSUM6PQn5gn47` (verified: 0 `model-switched` tool parts in session; an earlier raw `LIKE '%model-switched%'` count of 27 was a false positive matching my own transcript text, see A6).
- failed consults never increment `calls` — only `errors` + `estTokensIn` (verified at dist lines 441–446, 494–500, 527–542).

### Totals so far

| | PASS | FAIL | NOT RUN |
|---|---|---|---|
| Tier 1 | 10 | 0 | 0 |
| Tier 2 | 0 | 2 | 4 |
| **Total** | **10** | **2** | **4** |

---

## 2. The 90s-timeout failure pattern (verbatim)

Both paid consults failed identically — the advisor sub-call was hard-capped by the default `timeoutMs: 9e4` (dist line 568, applied via `withTimeout` at line 497):

```
advisor_tool_result_error: execution_time_exceeded — advisor sub-call timed out after 90000ms
```

(advice string was 93 chars: head == tail == the error line.)

Key detail from L2: the agent-mode child session **completed at 90.2s** — the provider responded ~200ms after the parent's 90s deadline. The request reached the transport (diag at 10:12:53.563Z = L1 start: `{"kind":"generate","messages":1,"systemParts":0,"tools":0,"chars":148266}` / `{"kept":1,"dropped":420}`) and was being served; the timeout, not the provider, produced the failure.

---

## 3. Spend summary (usage ledger)

Ledger key (process-global): `plugin:<hex-("opencode-advisor")>:usage:2026-09-26`

| Point | calls | errors | estTokensIn | estTokensOut | adviceChars |
|---|---|---|---|---|---|
| Pre-run baseline | 15 | 0 | 215,770 | 7,686 | 30,728 |
| After L2 (attributable to this run) | 15 | 2 | 236,834 | 7,686 | 30,728 |
| Final read (incl. concurrent sessions) | 17 | 2 | 301,856 | 10,393 | 41,551 |

- **This run's attributable spend:** 2 consults attempted, 2 failed → `errors` +2, `estTokensIn` **+21,064**, `estTokensOut` +0, `adviceChars` +0, `calls` +0.
- **≈ $0.03** at $1.40/M in (21,064 × $1.40/M = $0.0295) + **$0.00** out (failed consults record no output tokens — actual provider consumption for the two timed-out sub-calls is not captured by the ledger; see A5).
- Full-ledger observed delta (all sources on this box): +86,086 in / +2,707 out ≈ **$0.13** — but ~3/4 of that is concurrent-session pollution, not this regression.
- **L3–L6: zero spend** (never invoked).

---

## 4. Config restore proof

Stop-order target bytes (no trailing newline):

```
{"advisor":{"providerID":"zai-coding-plan","id":"glm-5.3"},"transcriptBudgetTokens":32000,"maxToolOutputChars":3000}
```

| Check | Result |
|---|---|
| `cmp` vs expected bytes (immediately after write) | **IDENTICAL** |
| `cp dist/opencode-advisor.js → .../opencode-advisor/index.js && sleep 6` | executed (10:57:55Z) |
| New `msg="loading plugin"` line | **yes** — `timestamp=2026-09-26T10:58:01.247Z … msg="loading plugin" id=/Users/hareeshkarravi/.config/opencode/opencode-advisor entrypoint=file:///…/index.js` |
| `cmp` after reload | **IDENTICAL** |
| Stability recheck (+5s) | **IDENTICAL** |
| sha256 (final) | `df9db5fa96dd925952e6e553412844f06703a5b1f9c2825a44fb0c544728accc` |
| Pre-run backup `advisor-config.baseline.json` | sha256 `8648a77397c6fdab236f9f10ef4534ec959445d1081e3363c368e5dbc881df7c` — semantically identical JSON, pretty-printed whitespace differs from the stop-order compact bytes (the stop-order byte form hashes to `df9db5fa…`). No key/value differences. |

---

## 5. Anomalies

- **A1 — R1 substring nuance:** the raw invariant (`!evidence.includes("ADVISOR REVIEW by ")`) fired on 2 hits; both are quoted plugin source/test text inside tool output, not advisor frames (0 full-frame slices after normalize; `isAdvisorOutputFrame=false` for both). Adjudicated PASS; the detector-level invariant (R8/R10) is the sound one.
- **A2 — L1/L2 90s timeouts:** provider latency sits at ~90s+ for this workload; the default `timeoutMs: 90000` turns a slow-but-successful consult into a hard failure. This is the failure pattern the user aborted on (redesigned in v0.8.0).
- **A3 — L2 orphaned child session:** agent-mode child `ses_f22c9b1e5ffeROl0Go1Bybiy5g` completed server-side at 90.2s, ~0.2s after the parent timed out — the advice was delivered to a session nobody read; work and tokens spent, nothing returned.
- **A4 — possible stale build at L1:** stored `diag:body` lacked the `transport` key that the current `dist` writes (line 2693); the build loaded at L1's start may predate the last `dist` edit (last `cp` was 09:49:34; only `npm run typecheck` afterwards).
- **A5 — failed-consult accounting:** failure path records `estTokensIn += ceil(promptChars/4)` but no output tokens and no `calls`; real provider spend for timed-out sub-calls is therefore under-reported.
- **A6 — shared/global keys:** the usage ledger and `diag:*` kv keys are process-global (not session-scoped). Concurrent OpenCode sessions on this box polluted deltas (calls 15→17, estTokensIn +86k while this run only accounted +21k). Also, a raw `session_message.data LIKE '%model-switched%'` count is a false positive over transcript text; the correct check is `type=tool` parts with `tool="model-switched"` → **0**.
- **A7 — concurrent external config mutation:** during the run the live config was overwritten twice by another actor (16:08:51 local: `"timeoutMs":600000` appeared; 16:23:31 local: `preset:exhaustive + advisorMode:review-agent + timeoutMs:600000` written **with a plugin reload** — log `10:53:30Z` shows the other session's command). Restored to stop-order bytes and reloaded after each; final state verified above. Re-check this file's §4 if the box still has concurrent sessions.

---

**ABORTED BY USER — timeout semantics being redesigned (v0.8.0); regression to be re-run after deploy**
