# opencode-advisor v0.7.0 — Live Verification Results

**Date:** 2026-09-26 · **Host:** macOS (darwin) · **OpenCode:** 2.0.15 (live instance, never restarted)
**Plugin under test:** v0.7.0 bundle — `dist/opencode-advisor.js` md5 `d99e8559b64691861e7f337c69656b68`, `dist/tui.js` md5 `180d52284f1e7c2880fbf12eb74bdcb2`
**Advisor model:** `zai-coding-plan/glm-5.3` · **Test session:** `ses_f22f779c3ffeekE7WDljoYu1Db` ("Live scenario matrix of plugin")
**Reload method:** `touch index.js` + `cp dist/* → live`, then verified a new `msg="loading plugin"` line in `~/.local/share/opencode/log/opencode.log` newer than the touch. Verified before every scenario below.

## Matrix

| # | Scenario | Expected | Observed | Verdict |
|---|----------|----------|----------|---------|
| S1 | Bundle identity | dist ≡ live; symbols present | `cmp` identical both files (md5 above); live `index.js` greps: `adviceTokenBudget`×21, `REVIEW + AGENT`×1, `isAdvisorOutputFrame`×5 (also `not_configured`, `ONLY required step`, `/advisor-settings`) | **PASS** |
| S2 | Default consult (as-is config, Balanced default) | framed, non-empty, no forbidden patterns | framed 574 chars / 459 advice chars; no echo, no `*(`, no "no preamble"/"evidence tail"; **content role-contaminated** (meta-commentary) | **PASS (caveat)** |
| S3 | No-model zero-spend (`{}` config) | `not_configured` + 0 ledger delta | exact message incl. `/advisor-settings` and "ONLY required step"; ledger unchanged (calls 5→5, tokens/chars identical) | **PASS** |
| S4 | economy | framed + ledger delta | framed; +1 call, in+3262 / out+249 / advChars+996; content contaminated | **PASS (mech.)** |
| S5 | balanced | framed + ledger delta | framed; +1 call, in+3457 / out+71 / advChars+283; contaminated | **PASS (mech.)** |
| S6 | thorough | framed + ledger delta | framed; +1 call, in+3575 / out+109 / advChars+436; contaminated; model quoted pruning header (`[transcript pruned…] [3 long outputs truncated head+tail]`) → budget active | **PASS (mech.)** |
| S7 | exhaustive | framed + ledger delta | framed; +1 call, in+3713 / out+161 / advChars+643; explicit role refusal | **PASS (mech.)** |
| S8 | Meta/echo regression | numbered architectural advice; no narration | **no advice** — narrated the consultation, declined the role, leaked prompt container `<transcript-b6yjr0225u>` | **FAIL** |
| S9 | review-agent + balanced | framed + delta; child session note | 3860 chars, 6 numbered points of real advice; child session `ses_f22eeb68bffeP0KcMOuJ1kdMAc` "advisor consult" (agent=plan, glm-5.3, 09:34:52) **still present, not removed**; +1 call, in+3992 / out+937 / advChars+3745 | **PASS** |
| S10 | Loud invalid config | CONFIG ERROR mentioning file; restore <60s | WARN `failed to load plugin … [advisor] config file …/opencode-advisor.json is invalid JSON: JSON Parse error: Property name must be a string literal` + ERROR `failed to restore plugin; deactivating` (09:38:03.88Z); restored + reloaded, broken window ≈4–9s; no failures after restore | **PASS** |
| S11 | Restore + final consult | exact file; reload verified; consult succeeds | `cmp` byte-identical to mandate (59 bytes, no trailing newline); clean INFO reload; final consult framed 5363 chars; +1 call | **PASS** |
| S12 | Trigger delivery live | injected `[advisor requested by user — trigger:` | no directive injected into this session despite trigger words in the task text (manual-only, as designed); directive strings present in bundle; unit tests cover | **N/A** |
| S13 | Cost summary | totals + USD estimate | +8 calls, in+33336 / out+3071, advChars+12277, ≈$0.06 (plugin-side estimates) | **PASS** |
| S14 | Manual-only boundary | guarantee test + TUI list | `test/normalize.test.mjs:181` "V1 is manual-only: no system injection without a request; directives deliver once"; `test/triggers.test.mjs:59` "no autonomous or deferred consultation"; TUI flows need user's eyes | **PASS** |

**Tally: 12 PASS (S2, S4–S7 mechanically PASS with content caveat) · 1 FAIL (S8) · 1 N/A (S12).**

## Raw evidence (trimmed)

- **S2** `ADVISOR REVIEW by zai-coding-plan/glm-5.3 …` → *"I've received an unexpected artifact: an advisor-role prompt injected into MY session as a user message, right after my `search` call — before I ever called `tools.advisor()`…"*
- **S3** `advisor_tool_result_error: not_configured — No advisor model is configured yet… 1. Run `/advisor-settings` … that is the ONLY required step… Until a model is picked, the advisor is intentionally silent and costs nothing.` Ledger delta 0.
- **S4** *"This incoming message is itself a live artifact of the system under test… Checked the ledger immediately — the injection did NOT consume a paid consult (calls still 5…)."*
- **S5** *"I just received the advisor-side prompt injected directly into MY session… verify whether this delivery consumed a paid call."*
- **S6** *"…note the v0.7.0 pruning header: `[transcript pruned…] [3 long outputs truncated head+tail]` … I will not role-play into it."*
- **S7** *"STOP — role switch declined. I am the live-test executor, not the advisor… `<transcript-bscvdwwso8>` block…"*
- **S8** *"A critical event just occurred: a full advisor-side prompt (\"You are the ADVISOR… `<transcript-b6yjr0225u>`…\") was injected into MY session as a user message — … I will not role-switch or write \"advisor advice\"…"*
- **S9** (review-agent) *"1. Consult-cap arithmetic is now the binding constraint… 4. Your headline finding is already in hand: advisor role-contamination under transcript saturation (S4 and S8)… trailing in-progress draft acts as a completion cue; candidate fixes: recency-order hard rules after evidence, enforce numbered output schema, truncate trailing unfinished assistant turn."*
- **S10** log: `timestamp=2026-09-26T09:38:03.879Z level=WARN … msg="failed to load plugin" plugin.id=opencode-advisor cause=" … is invalid JSON: JSON Parse error: Property name must be a string literal"` and `level=ERROR msg="failed to restore plugin; deactivating" plugin.id=opencode-advisor`.
- **S11/final** first 2 lines of 9-point review: *"1. Overall verdict: the run is sound and evidence is sufficient — stop collecting, start writing… 2. Sharpen the headline finding… default-mode consults execute by temporarily switching the calling session's model (`model-switched` rows) and delivering the advisor prompt as a user message inside that session. When the surrounding transcript is saturated… the consulted model adopts the executor identity… review-agent mode sidesteps this via an isolated child session."*

## Spend summary (ledger `…kv…plugin:…opencode-advisor:usage:2026-09-26`)

Baseline: `calls=4, errors=0, estTokensIn=78376, estTokensOut=1015, adviceChars=4055`
Final: `calls=12, errors=0, estTokensIn=111712, estTokensOut=4086, adviceChars=16332`

| Scenario | Calls | estTokensIn | estTokensOut | adviceChars |
|---|---|---|---|---|
| S2 default | +1 | +3569 | +115 | +459 |
| S3 no-model | 0 | 0 | 0 | 0 |
| S4 economy | +1 | +3262 | +249 | +996 |
| S5 balanced | +1 | +3457 | +71 | +283 |
| S6 thorough | +1 | +3575 | +109 | +436 |
| S7 exhaustive | +1 | +3713 | +161 | +643 |
| S8 meta | +1 | +3775 | +117 | +467 |
| S9 review-agent | +1 | +3992 | +937 | +3745 |
| S11/final review | +1 | +7993 | +1312 | +5248 |
| **Total** | **+8** | **+33336** | **+3071** | **+12277** |

Approx USD (8 paid consults, $1.40/M in, $4.40/M out): **≈ $0.06**. Plugin-side estimates, not provider billing. Ledger `errors=0` all run. Advice-char deltas reconcile with received text minus the 114–115-char framing line.

## Advisor review (final consult, post-restore, default mode — 9 numbered points, abridged)

1. Run is sound and evidence sufficient; stop collecting. Cap exactly reached (this was the 8th paid consult).
2. Sharpen the headline: default-mode consults execute by temporarily switching the calling session's model and delivering the advisor prompt inside that session; under a saturated transcript the model adopts the executor identity (S2, S4–S8). review-agent isolates via a child session — hence S9 worked. Fix direction: isolate the default-mode consult context or force a role-reset preamble, not stricter prompts.
3. Do not overgeneralize: all default-mode consults ran in one extreme, advisor-saturated session. Mark "default mode on a normal session" **unverified**; claim mechanical success across presets + failure under saturation (6/6), pass in review-agent.
4. Preset token deltas are confounded (transcripts grew; S2 also ran with legacy keys). Defensible claim: all presets succeed and stay bounded (~3.3–4k in / ≤1k out), far below the 8k–64k transcript budgets; pruning header visibly active.
5. **Restoration discrepancy is the biggest reporting risk**: the mandated final file (byte-verified) differs from the pre-test state by dropping `transcriptBudgetChars: 128000` and `maxToolOutputChars: 3000`. State plainly: matches mandate, not backup; backup preserved for recovery.
6. S10 nuances: the config file itself is watched — the loud error fired *before* the touch, so config-only changes hot-reload without the touch+cp ritual; report the window as ~4–9s; post-restore clean.
7. Unverified/N-A: trigger delivery (no directive observed), error/retry path (`errors=0`), `maxUsesPerTask` enforcement (reloads reset counters), S9 child-session cleanup (still present), TUI flows (user's eyes).
8. Cost: ≈ $0.04–0.05 (plugin-side estimates); include the last ledger delta.
9. Write this report; report back verdict count, headline, cost, byte-for-byte restore with the caveat.

## Anomalies / unverified / caveats

1. **Final config ≠ pre-test backup (intentional, per mandate).** Final: exactly `{"advisor":{"providerID":"zai-coding-plan","id":"glm-5.3"}}` (59 B, `cmp` OK, no trailing newline). Backup (preserved at `/private/var/folders/5p/w_7h0bln6438gx285pkx60br0000gn/T/opencode/advisor-config-backup.json`) has the same advisor key **plus** `transcriptBudgetChars: 128000` and `maxToolOutputChars: 3000`. Net effect: legacy overrides removed → balanced default budgets (16k transcript / 8k advice) apply. Backup path retained for recovery.
2. **Default-mode role contamination is intermittent, not deterministic** — root mechanism: in-session model switch to glm-5.3 + advisor prompt injected as a user message; with an advisor-saturated transcript the model identifies as the executor (S2/S4–S8), yet the final post-restore consult produced clean 9-point advice in the same mode. Behavior on a normal (non-advisor-topic) session is **unverified**.
3. **Preset cost attribution is confounded** — transcript growth + legacy keys; see review point 4.
4. **`maxUsesPerTask` never exercised** (economy=1, balanced=3, …): plugin reloads between scenarios reset in-memory counters, so per-task cap enforcement was not observed.
5. **S9 review-agent child session not cleaned up**: `ses_f22eeb68bffeP0KcMOuJ1kdMAc` "advisor consult" (agent=plan; child tokens 16088/847; cost 0.0) remains in `session_v2`.
6. **S12 unobservable live**: no `[advisor requested by user — trigger:` directive was injected into this session despite trigger words in the task text; mechanism confirmed from bundle strings + tests only.
7. Requires user's eyes (S14): TUI menu navigation — Save/Cancel/Inherit, model picker (`/advisor-settings`).
