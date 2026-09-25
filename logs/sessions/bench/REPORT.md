# Benchmark Report — Advisor vs No-Advisor (TTL LRU Cache Task)

**Date:** 2026-09-25
**Executor (both arms):** `opencode-go/deepseek-v4-flash`
**Advisor (arm B only):** `opencode-go/deepseek-v4.1-flash`
**Task:** `logs/sessions/bench/TASK.md` (identical prompt, advisor-agnostic)
**Methodology notes:** correctness (tests green = SWE-bench-style pass/fail),
  live tool-driven execution (terminal-bench-style), cost + wall-time
  (Artificial-Analysis-style). Single run per arm (pilot, not a trial).

## Results

| Metric | Arm A (no advisor) | Arm B (advisor) |
|---|---|---|
| Task success (suite green) | TBD | TBD |
| Assertions passing | TBD | TBD |
| Wall clock | TBD | TBD |
| Executor in/out tokens | TBD (session DB) | TBD (session DB) |
| Advisor calls (ledger) | 0 | TBD |
| Advisor in/out tokens (ledger) | 0 | TBD |
| Est. cost (Go price card) | TBD | TBD |
| Advisor advice samples | — | TBD (from session transcript) |

## Grading rubric (code review, both arms)

- [ ] Correctness: eviction order, TTL semantics, stats, serialization
- [ ] Edge cases: capacity 1, key update, missing-key delete, TTL 0
- [ ] Code quality: structure, O(1) discipline, readability
- [ ] Test quality: assertion count, meaningful coverage vs tautologies

## Verdict

TBD

## Plugin improvements derived

TBD
