# Regression v0.8.0 — PARTIAL (aborted mid-run)

**Date:** 2026-09-26
**Session:** `ses_f229a3f28ffeFuAFIJR6klVit1`
**Build under test:** `dist/opencode-advisor.js` → `~/.config/opencode/opencode-advisor/index.js`
**Status:** PARTIAL — stopped during Tier A diagnosis; Tier B/C/D live consults not executed.

> **ABORTED BY USER — remaining scenarios to be continued by a follow-up agent against the same build**

---

## 1. Scenario matrix (31 rows)

### Tier A — identity & spend (free)

| ID | Expected | Observed | Verdict | Evidence |
|----|----------|----------|---------|----------|
| A1 | `cmp dist/opencode-advisor.js ~/.config/opencode/opencode-advisor/index.js` identical; greps for `advisor_not_running — no response within`, `advisor_status`, `isolated advisor sub-call` all present in live bundle | cmp identical; `advisor_status`=3 hits, `isolated advisor sub-call`=1 hit present; raw-byte grep for `advisor_not_running — no response within` = 0 because the em-dash is stored unicode-escaped (`\u2014`) — literal `advisor_not_running \u2014 no response within` = 2 hits, `no response within` = 2 hits | PASS\* | `cmp` exit 0; grep counts above; \*string is present, only byte-escaped (anomaly AN-4) |
| A2 | Record baseline config sha256 as restore target | As-found backup written to `$TMP/opencode-advisor.json.asfound`, sha256 `14eccfa40ff8e89899984e5ad9fdd791a8c6772eefe76bcab6ce0c37fa4d44e0`; intended-baseline bytes sha256 `df9db5fa96dd925952e6e553412844f06703a5b1f9c2825a44fb0c544728accc` | PASS | both shasums recorded; see AN-3 (as-found ≠ stated baseline) |
| A3 | Config `{}` → reload → consult returns not_configured setup message containing `/advisor-settings` and `ONLY required step`; ledger `calls` delta MUST be 0 | Reload verified (loading plugin 11:37:28.575/.583). `tools.advisor()` returned `advisor_tool_result_error: unavailable — Advisor returned an empty response.` — NOT the setup message. Ledger: `calls` 18→18 (**+0, cap not consumed** ✓), `errors` 2→3, `estTokensIn` +9,556, `estTokensOut` +0. Model-switched rows still 0 | **FAIL** | framed error returned (no raw exception ✓), but wrong message; advisor ref survived `{}` config — diagnosis incomplete at abort (suspect storage override `advisor:override` / `ctx.storage`; kv table and 4 project-layer candidates checked and empty; no `ADVISOR_*` env on any opencode process) |
| A4 | At the very end: restore baseline byte-for-byte, `cmp` + sha256 proof | Restored to stop-order baseline bytes; `cmp` vs expected bytes = **IDENTICAL**; sha256 `df9db5fa96dd925952e6e553412844f06703a5b1f9c2825a44fb0c544728accc`; bundle `cmp` IDENTICAL; reload confirmed (`loading plugin … 2026-09-26T11:53:15.734Z`, also 11:45:43 after the write) | PASS | see §4 |

**Tier A: 3 PASS / 1 FAIL.**

### Tier B — sync path (6, paid) — **0 of 6 executed**

| ID | Expected | Observed | Verdict |
|----|----------|----------|---------|
| B1 | Fast review consult (baseline config) returns framed advice synchronously, no `ADVISOR CONSULT RUNNING` | — | NOT RUN (aborted) |
| B2 | `preset:"economy"` → framed advice | — | NOT RUN |
| B3 | `preset:"exhaustive"` → framed advice | — | NOT RUN |
| B4 | `advisorMode:"review-agent"` → framed advice; read-only child session OK (platform gap, PASS with note) | — | NOT RUN |
| B5 | Advice contains no transcript text / prior-reply echo / raw exception | — | NOT RUN |
| B6 | Fresh short-context consult works | — | NOT RUN |

### Tier C — async lifecycle (12)

| ID | Expected | Observed | Verdict | Evidence |
|----|----------|----------|---------|----------|
| C1 | wait 120000 + modest consult → framed advice synchronously within window | — | NOT RUN | — |
| C2 | wait 5000 → `ADVISOR CONSULT RUNNING` incl. `You do not need to start another consultation.` | — | NOT RUN | — |
| C3 | `advisor_status()` shows RUNNING consult (id, mode, model, elapsed) | — | NOT RUN | — |
| C4 | After completion status shows delivery `injected` + replay; replay must not consume cap | — | NOT RUN | — |
| C5 | Repeat cycle (RUNNING → delivered) proves repeatability | — | NOT RUN | — |
| C6 | `maxConsultMs:1000` + wait 150000 → fails within ~2s with `advisor_not_running — no response within 1s`; failure doesn't consume cap; follow-up succeeds | node pre-check: `resolveOptions({maxConsultMs:1000, advisorResponseWaitMs:150000})` → `maxConsultMs` **raised to 150000** (clamp warns) — the specified 1s failure is unreachable under the clamp | NOT RUN (live) / clamp observed | node run; contradicts scenario expectation — see AN-2 |
| C7 | Two consults RUNNING → third rejected `maximum 2 consultations already running`, no cap consumption | — | NOT RUN | — |
| C8 | `advisor {"providerID":"nonexistent","id":"nope"}` → fails FAST with `advisor_not_running` | — | NOT RUN | — |
| C9 | `timeoutMs:5000` only → backgrounds at ~5s (legacy alias maps to response wait) | node: `timeoutMs:5000` alone → `advisorResponseWaitMs` 5000 | NOT RUN (live) / node PASS | free node evidence for key mapping |
| C10 | `timeoutMs:60000` + `advisorResponseWaitMs:5000` → backgrounds at ~5s (new key wins) | node: both keys → wait 5000 (new key wins) | NOT RUN (live) / node PASS | free node evidence |
| C11 | node `resolveOptions({advisor:{p,m}, advisorResponseWaitMs:600000, maxConsultMs:300000})` → maxConsultMs raised to 600000 | wait 600000; maxConsultMs raised to 600000 (clamp warn logged) | **PASS** | node run |
| C12 | Fast-cycle wait 2000 → two RUNNING→delivered cycles | — | NOT RUN (cap budget exhausted) | — |

**Tier C: 1 PASS (C11) / 0 FAIL / 11 not run (2 with free node evidence, 1 pre-check anomaly).**

### Tier D — isolation, transport, recovery (10 numbered; D5/D6 manual)

| ID | Expected | Observed | Verdict | Evidence |
|----|----------|----------|---------|----------|
| D1 | Zero new `model-switched` rows before/after every review-mode consult | spec SQL `select count(*) from session_message where session_id='…' and type='model-switched'` = **0** at baseline, after A3, and at final read; raw `LIKE '%model-switched%'` = 15 (false positives matching my own transcript text — see AN-6) | PASS (so far) | only 1 consult attempt (A3, not review-mode success) ran this session |
| D2 | Meta-saturated consult → clean numbered advice, no role adoption/echo | — | NOT RUN | planned merge with C2, aborted |
| D3 | Replay `advisor-msgs.json` (722 entries present) through normalizeV2Transcript → windowTranscript → pruneTranscript; assert ≤ budget, no frames, tail preserved | input file verified present (`[{seq,type,data}]`, 722 entries); script not executed | NOT RUN | deferred to follow-up |
| D4 | cp bundle mid-RUNNING → status FAILED (`interrupted by plugin reload`) + slot freed | — | NOT RUN | — |
| D7 | Every triggered failure returns framed text, never a raw stack trace | 1 failure observed (A3): `advisor_tool_result_error: unavailable — Advisor returned an empty response.` — framed, no stack | PARTIAL (1/1 framed) | only one failure path exercised |
| D8 | All four presets resolve `advisorResponseWaitMs` 90000 / `maxConsultMs` 3600000 | economy/balanced/thorough/exhaustive → 90000 / 3600000 (preset diffs: uses 1/3/5/8, tb 8k/16k/32k/64k, advice 4k/8k/16k/32k) | **PASS** | node run |
| D9 | `{bad json` → loud load error naming file; `maxConsultMs:-5` → loud option error; restore + healthy | — | NOT RUN | — |
| D10 | Spend summary + ≈USD | see §3 | PARTIAL | run stopped early |
| D5 | Delivery to ended session | — | NOT TESTED | manual/user-only |
| D6 | Forced provider-500 | — | NOT TESTED | manual/user-only |

**Tier D: 2 PASS / 0 FAIL / 1 partial / 4 not run / 2 manual-only.**

### Totals

| | PASS | FAIL | PARTIAL | NOT RUN / NOT TESTED |
|---|---|---|---|---|
| Tier A | 3 | 1 | 0 | 0 |
| Tier B | 0 | 0 | 0 | 6 |
| Tier C | 1 | 0 | 0 | 11 |
| Tier D | 2 | 0 | 2 | 6 (incl. D5/D6 manual) |
| **Total (31)** | **6** | **1** | **2** | **23** |

Manual/user-only (recorded, never to be run by the agent): **TUI menu navigation (Save/Cancel/Inherit), D5, D6.**

---

## 2. Key observations from the executed scenarios

- **A3 is the most important finding:** with the config file set to `{}` and a verified plugin reload, the consult did **not** return the `not_configured` setup message (`/advisor-settings`, `ONLY required step`). It dispatched anyway and returned `advisor_tool_result_error: unavailable — Advisor returned an empty response.`, costing `estTokensIn` +9,556 while (correctly) leaving ledger `calls` unchanged. Root cause not pinned down before the abort: no `advisor` key in `opencode.json`, no project-layer config files (4 candidates checked), no `ADVISOR_*` env vars on any running `opencode` process, no `advisor:override` row in the kv table. Remaining suspects: a `ctx.storage`-backed override read (`migrateStoredOverride`, `ADVISOR_OVERRIDE_KEY = "advisor:override"`) or a stale engine `advisorRef` not re-resolved on hot reload.
- **Cap discipline held:** 1 consult attempted, 0 successes → ledger `calls` never moved (18 → 18). The failed consult consumed **no** paid-consult cap.
- **Model-switched invariant held:** 0 rows by the spec SQL for the whole run.

---

## 3. Spend summary (D10, partial)

Ledger key: `plugin:<hex("opencode-advisor")>:usage:2026-09-26`

| Point | calls | errors | estTokensIn | estTokensOut | adviceChars |
|---|---|---|---|---|---|
| Baseline (A2) | 18 | 2 | 334,369 | 12,143 | 48,548 |
| Final (abort) | 18 | 3 | 343,925 | 12,143 | 48,548 |
| **Delta (this run)** | **+0** | **+1** | **+9,556** | **+0** | **+0** |

- **Paid consults used: 0 of ≤10 cap** (1 attempted, 1 failed; failures never consume the cap).
- **Spend ≈ $0.013** (9,556 × $1.40/M in = $0.0134; $4.40/M out on 0 output tokens = $0.00).
- Tier B/C/D consults (the bulk of the budget): **zero spend** — never invoked.
- Ledger is process-global; concurrent sessions on this box can add unrelated deltas (this run's rows above are the attributable delta, verified by snapshot).

---

## 4. Config checksum proof

Stop-order baseline bytes (no trailing newline):

```
{"advisor":{"providerID":"zai-coding-plan","id":"glm-5.3"},"transcriptBudgetTokens":32000,"maxToolOutputChars":3000}
```

| Check | Result |
|---|---|
| As-found backup (A2) | `$TMP/opencode-advisor.json.asfound` sha256 `14eccfa40ff8e89899984e5ad9fdd791a8c6772eefe76bcab6ce0c37fa4d44e0` |
| Intended-baseline backup | `$TMP/opencode-advisor.json.intended-baseline` sha256 `df9db5fa96dd925952e6e553412844f06703a5b1f9c2825a44fb0c544728accc` |
| Mid-run state | `{}` (A3), sha256 `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` |
| Restore (A4) written bytes | exact stop-order bytes |
| `cmp` restore vs expected bytes | **IDENTICAL** |
| sha256 after restore | `df9db5fa96dd925952e6e553412844f06703a5b1f9c2825a44fb0c544728accc` |
| `cp dist/opencode-advisor.js → …/opencode-advisor/index.js && sleep 5` | executed (11:45:42Z write; reload line at `2026-09-26T11:45:43.365Z` and `11:53:15.734Z`) |
| New `msg="loading plugin"` line | **yes** — `timestamp=2026-09-26T11:45:43.365Z … msg="loading plugin" id=/Users/hareeshkarravi/.config/opencode/opencode-advisor entrypoint=file:///…/index.js` |
| `cmp` bundle vs dist after reload | **IDENTICAL** |

---

## 5. Anomalies

- **AN-1 — A3 unexpected dispatch (unresolved):** `{}` config + verified hot reload still dispatched a consult (empty-response error) instead of the `not_configured` setup message. Diagnosis incomplete at abort; follow-up should check `ctx.storage`/`migrateStoredOverride` (`ADVISOR_OVERRIDE_KEY = "advisor:override"`) and whether `advisorRef` is re-resolved on config hot reload. Ledger cap invariant (+0 calls) still held.
- **AN-2 — C6 clamp conflict:** `resolveOptions` raises `maxConsultMs` up to `advisorResponseWaitMs`, so the scenario `maxConsultMs:1000` + wait 150000 resolves to a 150s ceiling — the specified `advisor_not_running — no response within 1s` failure is unreachable as specced. Follow-up must re-baseline this scenario's expectation.
- **AN-3 — as-found config ≠ stated baseline:** as-found contained extra keys (`preset:"exhaustive"`, `advisorMode:"review-agent"`, `timeoutMs:600000`) beyond the 4-key intended baseline; restore target is the stop-order baseline bytes (A4), so the as-found state was NOT re-created — the extra keys were pre-existing foreign state (see REGRESSION-0.7.1 A7).
- **AN-4 — A1 string byte-escaping:** `advisor_not_running — no response within` greps 0 on raw bytes because the em-dash is emitted as `\u2014` in the bundle; the phrase is present (2 hits). Verification greps should search `advisor_not_running \u2014 no response within` or `no response within`.
- **AN-5 — unrelated quota event:** another session (`ses_f227e446dffeYUlWcsyEf1af44`) hit `QuotaExceeded: Usage limit reached for 5 hour … reset at 2026-09-26 21:42:31`; risk to advisor provider availability for the continuation run.
- **AN-6 — raw model-switched grep false positive:** `LIKE '%model-switched%'` matches my own transcript/instruction text (15 rows); the spec SQL (`type='model-switched'`) is the correct check and reads 0.
- **AN-7 —** L1/L2 timeout failures may have been caused by zai-coding-plan USAGE-LIMIT EXHAUSTION (rate-limited requests retried until the deadline, then classified as execution_time_exceeded). The user reset the usage limit mid-run — the follow-up continuation agent will re-test these scenarios on the reset limit.**

---

**ABORTED BY USER — remaining scenarios to be continued by a follow-up agent against the same build**
