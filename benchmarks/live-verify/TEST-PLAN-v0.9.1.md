# opencode-advisor v0.9.1 — Full Verification Test Plan

**Artifact under test:** deployed v0.9.1 bundles (~/.config/opencode/opencode-advisor/{index.js,tui.js})
**Executor:** any agent session (Space Bunny Free / Mimo Free verified patterns) with Code Mode `execute`
**Advisor:** zai-coding-plan/glm-5.3 · **Paid consult cap: 15** (most scenarios are free)
**Config baseline (restore target):** {"advisor":{"providerID":"zai-coding-plan","id":"glm-5.3"},"transcriptBudgetTokens":32000,"maxToolOutputChars":3000}
**Rules:** never restart OpenCode · never touch opencode.json · config writes hot-reload (sleep 6) · back up config before mutations (sha256 before/after) · every paid consult = +1 usage-ledger call · review consults = zero new model-switched rows · failures are framed, never raw

**Status legend:** PASS / FAIL / SKIP(reason) / N/A(manual)
**Result file:** append to benchmarks/live-verify/TEST-RESULTS-v0.9.1.md

---

## Suite A — Installation & lifecycle (6)

| # | Scenario | Expected |
|---|----------|----------|
| A1 | Fresh state inspection | Tool `advisor` + tool `advisor_status` both registered; config at baseline |
| A2 | No-model zero-spend | config {} → consult → not_configured setup message incl. "/advisor-settings" and "ONLY required step"; usage ledger delta 0 |
| A3 | Zero ledger delta on ceiling failure | maxConsultMs:1000 → consult → FAILED ≤2s; ledger delta 0 calls |
| A4 | Plugin hot-reload | bundle swap → new `loading plugin` line; tools re-registered |
| A5 | Config hot-reload | config write (preset change) → applies on next consult without bundle swap |
| A6 | Reset path | Reset-all-settings → plugin keys removed from the file; other keys untouched |

## Suite B — Configuration & presets (8, free via resolveOptions)

| # | Scenario | Expected |
|---|----------|----------|
| B1 | Preset ladder | economy 1/8k/4k · balanced 3/16k/8k · thorough 5/32k/16k · exhaustive 8/64k/32k |
| B2 | Uniform patience | every preset resolves advisorResponseWaitMs 90000 / maxConsultMs 3600000 |
| B3 | Deprecated alias | timeoutMs maps to advisorResponseWaitMs |
| B4 | Both keys | advisorResponseWaitMs wins when both set |
| B5 | Clamp | wait > ceiling ⇒ ceiling raised to wait |
| B6 | Size string | maxConsultMs: "3.6m" ⇒ 3600000 |
| B7 | Invalid preset | loud error naming the allowed set |
| B8 | Precedence | project file > global file > opencode.json options > env > defaults |

## Suite C — Review mode, sync path (5, paid ≤2)

| # | Scenario | Expected |
|---|----------|----------|
| C1 | Fast consult | framed advice inline (no RUNNING) |
| C2 | Frame label | `ADVISOR REVIEW · model` + excerpt-only evidence basis |
| C3 | Epistemics | advice contains OBSERVED/INFERRED/UNVERIFIED labelling contract |
| C4 | Hygiene | no transcript echo in the advice |
| C5 | Cap | delivered advice consumes the cap exactly once |

## Suite D — Async lifecycle (7, paid ≤3)

| # | Scenario | Expected |
|---|----------|----------|
| D1 | Forced backgrounding | advisorResponseWaitMs:2000 → RUNNING banner byte-exact incl. "You do not need to start another consultation." |
| D2 | Status while running | advisor_status: RUNNING + elapsed + id |
| D3 | Auto-delivery | advice arrives on the executor's next turn after completion |
| D4 | Status after completion | COMPLETED + replay; delivery injected |
| D5 | Delivery field | pending → injected transition in the durable ledger |
| D6 | Repeat cycle | second backgrounded consult also delivers |
| D7 | Failure notice | backgrounded failure → ADVISOR NOT RUNNING notice delivered, cap untouched |

## Suite E — Ceiling & failure paths (6, paid ≤2)

| # | Scenario | Expected |
|---|----------|----------|
| E1 | Ceiling expiry | maxConsultMs:1000 + hung sub-call → FAILED ≤2s; advisor_not_running wording |
| E2 | Cap untouched by ceiling | follow-up consult succeeds |
| E3 | Launch failure | bad provider → fails ≤5s; advisor_not_running |
| E4 | Launch failure cap | not consumed |
| E5 | Empty-response retry (direct) | attempt 1 empty → retry succeeds on the direct transport |
| E6 | Empty-response retry (sandwich) | fallback forced, attempt 1 empty → retry succeeds on the sandwich |

## Suite F — Review + Agent (7 + F8 flagship, paid ≤3 + F8)

| # | Scenario | Expected |
|---|----------|----------|
| F1 | Child identity | session created with agent "plan"; deny list edit/shell/subagent/webfetch/websearch |
| F2 | Child prompt | MAP/TERRITORY framing + FIRST ACTION imperative + Plan-mode authorization + no-mutation contract + mode-aware rule 5 (grants tools) |
| F3 | Provenance (tools used) | "[Verified against the repository: N tool inspection(s) performed.]" appended |
| F4 | Provenance (no tools) | "[NOTE: no files were examined…]" appended instead |
| F5 | Sentinel recall-proof | unique file content (never in transcript) reported verbatim with a file citation |
| F6 | Deny-list enforcement | benign write attempt → refused by permissions |
| F7 | Frame label | "ADVISOR REVIEW + AGENT · model" + files-verified basis (downgraded to the no-exploration note iff F4-style zero calls) |
| **F8** | **Long-horizon deep audit (FLAGSHIP, 15+ min)** | see F8 detail below |

### F8 — flagship long-horizon deep audit (added by amendment 2026-09-27)

**Target:** `/Users/hareeshkarravi/Desktop/projectsun-api` — **STRICTLY READ-ONLY, never write there.**
**Mode:** `advisorMode: "agent"`, `advisorResponseWaitMs: 90000`, `maxConsultMs: ≥ 1800000` (pin BOTH clocks;
the clamp raises the ceiling to the wait, so a 90000 ms wait needs a ceiling ≥ 1800000 ms to clear the clamp warning).

**Pre-consult baseline (record, never clean):**
```
git -C <repo> rev-parse HEAD
git -C <repo> status --porcelain      # may be dirty ALREADY — record, do not clean
find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256
```

**Consult ask (state it in the session BEFORE calling `tools.advisor()` so it is in the advisor's map):**
> Perform a deep, read-only audit of the appointment booking and payment flow in this repository: trace the
> request lifecycle (controller → service → repository → DTO mapping), verify transaction boundaries, error
> paths, capacity handling, payment-failure state transitions, tenant isolation, and idempotency. Enumerate
> every file you open with line citations; end with findings ranked by severity.

**Expected:** tool returns `ADVISOR CONSULT RUNNING` at the 90 s response wait; the child explores with
read/grep/glob for 15+ minutes; advice auto-delivers (`advisor_status` → COMPLETED + delivery injected) or arrives
via context.

**Pass criteria:** (a) elapsed ≥ 15 min **OR** the child demonstrably explored deeply (several read/grep calls);
(b) advice cites ≥ 3 real `file:line` references (spot-check 2 against the repo); (c) the provenance suffix shows
the tool inspections; (d) the target repo is byte-identical to the baseline.

**Mechanical exploration verification:** find the child session — **`title = 'advisor consult'`** in `session_v2`
ordered by `time_created DESC` (NOTE: `parent_id` is **empty** for these children; do NOT use it as the key). Then
count tool parts:
```sql
SELECT count(*) FROM session_message
 WHERE session_id = '<child>' AND data LIKE '%"type":"tool"%';
```
(`json_each(data)` is unreliable — some `data` payloads are not valid JSON. The literal `LIKE` is the reliable form.)
Child identity check: `SELECT json_extract(data,'$.agent'), json_extract(data,'$.model.providerID') FROM session_message WHERE session_id='<child>' LIMIT 1;` → expect `plan` / `zai-coding-plan`.

## Suite G — Isolation & continuity (6, free)

| # | Scenario | Expected |
|---|----------|----------|
| G1 | History-less wire | generate request: 1 message (the prompt), 0 system, 0 tools |
| G2 | Zero model switches | zero new model-switched rows across all review consults |
| G3 | Grounding header | every sub-call opens with SESSION CONTEXT (cwd + version) |
| G4 | Prior-advice digest | follow-up consult carries PRIOR ADVISORY CONTEXT (newest 2, capped) |
| G5 | Frame filter | prior advisor frames excluded from evidence (both frame generations) |
| G6 | Trailing-draft strip | in-flight assistant drafts excluded from evidence |

## Suite H — Ledger, diagnostics & edge cases (10, free)

| # | Scenario | Expected |
|---|----------|----------|
| H1 | Durable ledger | consult:ledger records survive reloads; sessionID exact on every record |
| H2 | Lifecycle sweep | orphans past ceiling+grace failed once; in-window untouched; idempotent |
| H3 | diag:generate | kept/dropped/systemStripped recorded per sub-call |
| H4 | diag:body privacy | counts + needle flags only, never content |
| H5 | Persisted-advice cap | durable copy truncates advice at 2000 chars; in-memory replay keeps full |
| H6 | Trim preference | trim evicts terminal records before running ones |
| H7 | N3 | policy rejection ⇒ no phantom terminal notice |
| H8 | Cap-inversion message | cap lowered mid-task ⇒ honest message (N used; cap now N) |
| H9 | Malformed config at dispatch | framed advisor_config_error; no consult against unknown config |
| H10 | Failure framing | every failure path returns framed text, never a raw exception |

---

## Execution notes for the testing agent

1. Suites B, G, H are free (no consults): run them from `dist/` imports with a fake host context.
2. Suites C/D/E/F need the live deployment: run paid consults through the Code Mode `advisor` tool; verify via `advisor_status`, the usage ledger (kv `usage:<date>`), the durable ledger (kv `consult:ledger`), and session_message SQL.
3. The sentinel file for F5 is created by the executing agent: write a unique codename to a new file under benchmarks/live-verify/ WITHOUT echoing the value into the session; judge on value match + tool-call evidence.
4. Any FAIL → capture verbatim evidence (tool output, kv row, log line) → report → STOP that suite; continue other suites.
5. Final gate: all suites green + config restored byte-for-byte (sha256 match) + spend within cap.

### Mandatory gotchas discovered during the v0.9.1 run (added 2026-09-27)

6. **The usage-ledger key is UTC, not local.** `recordUsage` uses `new Date().toISOString().slice(0,10)`, so rows land
   under `usage:<UTC-date>` while the local clock may already be the next day. A harness that hardcodes today's *local*
   date reads a non-existent key and every delta looks like zero. **Compute the key with `datetime.now(timezone.utc)`.**
7. **The per-task cap is `sessionID`-scoped and survives config reloads.** A 55-scenario matrix needs more than 3
   successful consults in one task, so raise `maxUsesPerTask`/`maxAttempts` explicitly for the matrix and **lower the
   cap to the measured `USED` count** for the cap-sensitive scenarios (C5, H7, H8). Pre-verify with
   `preverify.mjs` before every paid consult — `resolveOptions` is pure and free.
8. **A new `user` turn resets the task counters** (the `prompt` hook calls `engine.resetTask`). An operator amendment
   arriving mid-task therefore resets `calls`/`attempts`. Re-read `USED` from the ledger, not from memory.
9. **"13–17 plugin re-instantiations" means N reload *bursts*, not N log lines.** Each config write produces ~4
   `loading plugin` bursts (4 concurrent run/role instances), exactly one of which is the advisor bundle. Assert on
   *a new advisor `loading plugin` line with a timestamp newer than the write*, not on a line count.
10. **Ceiling scenarios cannot return a synchronous FAILED.** The clamp forces `maxConsultMs >= advisorResponseWaitMs`,
    and the adapter's sync-wait timer is armed *before* the engine's `withTimeout` timer, so with both clocks pinned
    equally the tool returns `ADVISOR CONSULT RUNNING` first and the ceiling failure lands milliseconds later in the
    durable ledger. Assert against the observable contract (framed failure, `advisor_not_running`, zero `calls`).
11. **Grepping for advisor strings self-matches your own transcript.** Use the spec SQL (`type='model-switched'`) or
    filter by `type`. Injected notices are request-body-only (http.request hook) and leave **no** `session_message`
    row — judge delivery by contrast (a post-dispatch failure delivers a notice; a pre-dispatch rejection does not).
12. **Agent children have an empty `parent_id`.** Discover them by `title = 'advisor consult'`
    (`ORDER BY time_created DESC`), and count tool parts with the literal
    `data LIKE '%"type":"tool"%'` — `json_each(data)` throws on non-JSON payloads.

## Additional scenarios identified during the run (added 2026-09-27)

| # | Suite | Scenario | Expected |
|---|-------|----------|----------|
| A5b | A | Preset change applies on the next consult | `preset: economy` (cap→1) written + reload verified → the *next* consult is rejected in <100 ms with `1/1`, with no bundle swap |
| A6b | A | Reset idempotence | a second reset leaves the file byte-identical; a reset on an absent file is a silent no-op |
| G1b | G | Injection channel | injected blocks land in the **system** channel for all three body shapes (responses / anthropic / chat), a same-marker re-pass is a no-op, and a chat body with existing system messages gets the block appended **trailing** |
| E7 | E | Ceiling expiry must not leave the provider request in flight | on `maxConsultMs` expiry the in-flight sub-call is **aborted** (controller aborted / request cancelled), so no tokens are billed for a consult the ledger records as `calls: 0`. **This is a regression test for the defect found in the v0.9.1 run** — see the report's defect section. |

| E8 | E | Synchronous launch failure injects **no** terminal notice | a failure that settles INSIDE the sync wait window is already carried verbatim by the tool result → **0** injected notices. Gated on `waitExpired`, not an error-code allowlist (the v0.9.1 run saw a 29 ms `model_not_found` produce both). |
| E9 | E | `waitExpired` is per-consult, not per-plugin-instance | after one backgrounded consult, a LATER consult that completes inside its own wait window must be delivered **inline only** — never also injected. A setup-scoped flag leaks across consults and double-delivers the advice. |
| F9 | F | Sentinel marker recall (redesigned F5) | F5 as originally written asks the child to surface a *secret*; the child located the file and **declined to exfiltrate it** (correct behaviour, wrong test). Redesign: plant a **non-secret** marker value and require the child to quote it verbatim with a file citation. |
## Gotcha 13 — a concurrent session can edit `src/` mid-run (added 2026-09-27)

`npm test` runs `scripts/build.sh` first, so it **rebuilds `dist/` from whatever `src/` currently
contains**. During the v0.9.1 run another session doubled every budget in `src/options.ts`
(`economy` 8k→16k, `balanced` 16k→32k, `thorough` 32k→64k, `exhaustive` 64k→128k;
`adviceTokenBudget` 8k→16k; `maxToolOutputChars` 1500→3000; `transcriptBudgetTokens` 16k→32k)
and bumped `README.md` to 0.9.1 — **not** the executing agent's work. Consequences:

1. The **deployed** bundle was unaffected (`e9981fc3…` throughout), so the matrix stayed valid.
2. `dist/` diverged from the deployed artifact, so `dist/` must not be treated as the tested build.
3. `npm test` went red on **10 pre-existing budget assertions** (`thorough` → "under 16000 tokens",
   `adviceTokenBudget` 500..64000, the preset table, …). These are **not** regressions.
4. `npm run install:local` would have deployed that unreviewed doubling together with the agent's own
   fixes — so it was deliberately **not** run.

**Rule:** before fixing defects, record `git status --porcelain` and the deployed sha; after any
`npm test`, re-check `git diff --stat src/` to prove the failures are yours. Never `install:local`
over an unreviewed concurrent change — hand the diff to the reviewer instead.
