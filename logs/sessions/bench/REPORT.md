# Benchmark Report — Advisor vs No-Advisor (TTL LRU Cache Task)

**Date:** 2026-09-25
**Executor (both arms):** `opencode-go/deepseek-v4-flash`
**Advisor (arm B only):** `opencode-go/deepseek-v4.1-flash`
**Task:** `logs/sessions/bench/TASK.md` (identical prompt, advisor-agnostic)
**Methodology notes:** correctness (tests green = SWE-bench-style pass/fail),
  live tool-driven execution (terminal-bench-style), cost + wall-time
  (Artificial-Analysis-style). Single run per arm (pilot, not a trial).

## Results — Pilot (TTL LRU cache)

| Metric | Arm A (no advisor) | Arm B (advisor) |
|---|---|---|
| Task success (suite green) | ✅ 17/17 | ✅ 10/10 |
| Assertions passing | 63 | 62 |
| Wall clock | 104s | 177s |
| Executor in/out tokens | 24,436 / 18,146 | 81,670 / 25,276 |
| Est. cost (Go card, flash $0.15/$0.60/M) | $0.01497 (ledger) | $0.02788 (ledger) |
| Advisor calls (ledger) | 0 | **0** |
| Trajectory | orient → write both files → test → done (5 turns) | orient → write both files → test → done (6 turns) |

### Pilot verdict

- **Baseline is strong**: flash executor solves routine implementation tasks directly, both arms green, comparable trajectories.
- **Advisor value unmeasured**: zero dispatches in arm B. The timing guidance permits skipping the advisor on tasks the executor judges trivial — consistent with Anthropic's published guidance ("on short reactive tasks ... skip it").
- **Zero interference**: arm B green with the plugin loaded (tool catalog + transient injections added ~650 tokens of overhead, negligible vs 57k trajectory variance).
- **Baseline wart (executor, not plugin)**: arm A `toJSON` serializes expired entries while `size` purges — minor inconsistency, tests still green.
- **Open question → Round 2**: does the executor escalate when it actually gets stuck? Requires a task with a mid-run failure surface (verifier-gated).

## Round 2 — Verifier-gated rate limiter (decisive test)

Same executor/advisor pair. Task ships with a **visible verifier** (`verify.mjs`,
FAIL_TO_PASS-style): the executor runs it, sees failures, debugs — the stuck
state where advisors earn their keep. Hidden nothing: verifier IS the oracle.
Grading: verifier pass/fail, verifier iterations, wall time, tokens, cost,
advice samples from transcript.

| Metric | Arm 2A (flash solo) | Arm 2B (flash + advisor) |
|---|---|---|
| Verifier | ✅ 11/11 first run | ✅ 11/11 |
| Own suite | 10/10 (47 assert) | 12/12 (62 assert) |
| Wall clock | 207s | 177s |
| Executor in/out tokens | 26,512 / 11,013 | 81,670 / 25,276 |
| Est. cost | $0.01147 | $0.02788 |
| Advisor calls (ledger) | 0 | **0** |

## Round 3/4 — Asymmetric pair + debugging (mimo-v2.6-flash executor)

Thesis test: weak executor + strong advisor (deepseek-v4.1-flash). Round 3
greenfield was passed solo by mimo too (88s), so Round 4 shipped SEEDED BUGS
(floored refill + stale timeUntilAvailable) with a falsely-green author suite
and a failing verifier — the stuck state.

| Metric | Arm 4A (mimo solo) | Arm 4B (mimo + advisor) |
|---|---|---|
| Verifier | ✅ 11/11 | ✅ 11/11 |
| Own suite | 12/12 (6 new regression tests) | 9/9 (3 new + mutation-validated) |
| Wall clock | 128s | 280s |
| Executor in/out tokens | 23,113 / 2,388 | 38,667 / 5,413 |
| Est. cost | $0.00535 | $0.01036 |
| Advisor calls (ledger) | 0 | **0** |
| Notable | Diagnosed bug interaction (masking) solo | Mutation-tested own regression tests solo |

## Hook-delivery proof (closes the pilot's ambiguity)

`diag:hookcheck` (one write per session's first model call, permanent) holds
arm 4B's own session ID timestamped 1s after its start: **context hooks fire
in one-shot `run` sessions**. Arm B executors had the tool + timing + nudge
and chose solo — mechanism exonerated, model choice confirmed.

## GLM advisor validation (zai-coding-plan, cap lifted)
- `glm-5.3-flash`: genuine role adherence (even discerned a content-free probe).
- Echo incidents EXPLAINED: degenerate self-referential tasks ("quote the
  advisor's response verbatim") create a liar-paradox loop — the model tries
  to comply by regurgitating input. Same model + same path advises superbly
  on real tasks. No plugin change (echo is visible garbage, not silent
  corruption; documented, not coded).

## FINAL VERDICT

Across 6 arms (pilot A/B, R2 A/B, R4 A/B): **all green, 0 advisor dispatches**.

1. **Baseline strength**: flash-tier (and mimo-tier) executors solve
   implementation AND two-bug debugging solo, fast and cheap ($0.005–0.03).
2. **Correct restraint**: the timing guidance explicitly permits skipping on
   tractable tasks; executors complied. Restraint is the designed behavior,
   not a failure.
3. **Zero interference**: every advisor-loaded arm went green; measured
   plugin overhead ≈ 650 tokens/run (tool description + timing prompt).
4. **Lift unmeasured, not refuted**: escalation threshold sits above
   flash/mimo solo capability at this task scale. The kimi E2E stands as
   qualitative proof that consulting works beautifully when invoked
   (sharp budget-respecting strategy, faithfully consumed).
5. **What would measure lift**: tasks above the solo threshold
   (multi-file ambiguity, genuine stuck states) or weaker executors —
   future work, ideally production telemetry on real stuck sessions.

## Plugin improvements derived (all shipped)

1. `diag:health` per consult + `diag:hookcheck` per session — permanent,
   bounded observability for exactly this class of question.
2. Setup race-guards on all unproven hooks (a hanging `http.request`
   registration once took the tool down silently — now impossible).
3. Advisor prompt rule 4 ("no tools, plain text only") — from observing
   executor-models emitting tool calls as text.
4. `model.unavailable` error pattern — from live bogus-id evidence.
5. No escalation-threshold changes: executors behaved per guidance;
   overfitting to benchmarks would corrupt the product.

## UX verification — frugal triggering live (v0.3.0)

- **Trigger-word flow, end to end**: directive persisted in the admitted user
  message (DB-verified), consult fired (ledger 16→17), advice consumed and
  refined into the answer (point-for-point tracking observed).
- **Explicit request → consults**: "Get consultation on X" → 18th successful
  consult (GLM-5.3, +897 advice chars), executor cited the key point.
- **Grant + trivial → restrains**: "you can use advisor if stuck" + "capital
  of France" → zero tool calls, direct answer, ledger unchanged. The
  request/grant disjunction works as designed.
- **Transient flake observed**: 1 empty-text provider response in 19 consults
  (~5%); executor fell back to a direct answer per the directive (correct —
  no silent retry burning credits). No code change; noted.
