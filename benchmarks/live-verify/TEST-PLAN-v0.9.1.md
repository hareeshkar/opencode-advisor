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

## Suite F — Review + Agent (7, paid ≤3)

| # | Scenario | Expected |
|---|----------|----------|
| F1 | Child identity | session created with agent "plan"; deny list edit/shell/subagent/webfetch/websearch |
| F2 | Child prompt | MAP/TERRITORY framing + FIRST ACTION imperative + Plan-mode authorization + no-mutation contract + mode-aware rule 5 (grants tools) |
| F3 | Provenance (tools used) | "[Verified against the repository: N tool inspection(s) performed.]" appended |
| F4 | Provenance (no tools) | "[NOTE: no files were examined…]" appended instead |
| F5 | Sentinel recall-proof | unique file content (never in transcript) reported verbatim with a file citation |
| F6 | Deny-list enforcement | benign write attempt → refused by permissions |
| F7 | Frame label | "ADVISOR REVIEW + AGENT · model" + files-verified basis (downgraded to the no-exploration note iff F4-style zero calls) |

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
