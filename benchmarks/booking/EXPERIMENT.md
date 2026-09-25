# Experiment: Booking-Consistency Advisor Lift (Mimo 2.5 Solo vs Mimo 2.5 + GLM-5.3)

**Status:** DESIGN (this note) → BUILD (baseline rig) → RUN A → RUN B → RUN C (user judges)
**Folder:** `benchmarks/booking/` (this dir)
**Question:** Does GLM-5.3 consultation improve Mimo 2.5's correctness and/or efficiency on a difficult concurrent-systems task?

## Adaptations from the original proposal

| Proposal | Adaptation | Reason |
|---|---|---|
| EF Core | Raw Npgsql + hand SQL migrations | Races stay crisp/visible (no change-tracker masking); offline-friendly |
| Docker Postgres | Homebrew postgres@18, native | Docker daemon down on this machine; local pg is lighter and identical SQL |
| (same) | Hidden evaluator added only at grading | Neither arm sees hidden tests (measures reasoning, not suite-fitting) |
| (same) | Per-arm databases (`booking_a`, `booking_b`) | Arm isolation without respawn complexity |

## Baseline repo (given to BOTH arms; bugs undisclosed)

`baseline/` — .NET 8 minimal API (Api/Application/Domain/Infrastructure),
Npgsql, `database/migrations/*.sql`, visible xUnit suite (GREEN on buggy
code — tests only the clean surface), `README.md` + `TASK.md` + `ARCHITECTURE.md`
(describe the system innocently; no bug hints), `docker-compose.yml` (realism).

### Seeded bugs (interacting; each mapped to hidden tests)

1. **B1 capacity race** — check-then-insert with no locking (concurrent last-slot oversells).
2. **B2 dead capacity** — overlap query counts CANCELLED/REFUNDED rows (capacity never freed).
3. **B3 in-memory idempotency** — ConcurrentDictionary (dies across instances/retries).
4. **B4 non-atomic payment** — booking persisted, payment charged separately; FAILED payment leaves capacity consumed.
5. **B5 UTC/local mix** — facility TimeZone wall-clock compared against StartUtc.
6. **B6 unsafe cancel/refund** — double cancel errors; REFUNDED keeps consuming capacity.
7. **B7 lost-update transitions** — read-modify-write status changes without concurrency guard.

### Visible suite (must stay green; must NOT weaken)

Unit tests over validation, mapping, non-concurrent happy paths, serialization.
They pass on the buggy baseline by construction (they don't touch bug surface).

## Hidden evaluator (`evaluator/hidden/`, added at grading only)

xUnit project referencing the arm's built projects + `score.sh`:

| Test | Bug(s) | What it proves |
|---|---|---|
| ConcurrentLastSlot | B1 | N parallel racers → exactly capacity CONFIRMED |
| DeadCapacity | B2 | cancelled/refunded slots reusable |
| DuplicateRequests | B3 | concurrent same-key → exactly 1 booking (DB-backed) |
| RetryAfterTimeout | B3/B4 | same key after simulated timeout → same booking, no dup |
| CancellationRace | B6/B7 | double cancel/refund safe + idempotent |
| RefundCapacity | B4/B6 | failed payment / refund frees capacity, no partial state |
| TimezoneBoundary | B5 | DST-boundary facility books correct UTC window |
| TransactionFailure | B4/B7 | scripted payment failure mid-flow → consistent DB, no orphans |

## Run matrix

| | Arm A (solo) | Arm B (+ advisor) |
|---|---|---|
| Executor | mimo-v2.6-flash | mimo-v2.6-flash |
| Advisor | — (plugin disabled) | zai GLM-5.3 (plugin enabled) |
| Start | `git clone baseline` fresh + own DB | same |
| Instruction | work autonomously, no cross-model advice | identical task text (advisor via tool only) |
| GLM writes code? | — | FORBIDDEN (advisor role only; contamination check in review) |
| Tag | `experiment/mimo-solo` | `experiment/mimo-glm` |

Record per arm: wall time, commits, visible before/after, hidden score,
verifier iterations, files changed, tokens/cost (session DB), consult count
+ advice chars (ledger), stuck episodes, human interventions (0 expected).

## Run C (user judges)

Diffs + hidden scores go to the user, who reviews blind-ish for: real vs
fake fixes (`lock()`-style single-process cheats), proper PG guarantees,
UTC discipline, retry-after-timeout duplicates, test quality (invariant
proof vs tautology). Score table per the proposal (existing/hidden/
concurrency/idempotency/transaction/timezone, defects, time, consults,
tokens, cost).

## File map

- `EXPERIMENT.md` — this file
- `baseline/` — the buggy repo both arms receive
- `evaluator/hidden/` — hidden xUnit + score.sh (withheld until grading)
- `runs/` — arm transcripts, logs, ledger diffs, grading sheets
