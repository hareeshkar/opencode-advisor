# Advisor Compliance & Long-Context Test Results

**Date:** 2026-09-26 · **Build:** v0.6.0-dev (commit series `1e77f93..head`) · **Tests:** 124/124

## The question

Does the executor reliably consult the advisor when explicitly instructed —
on short AND very long contexts — and what does the executor receive back?

## Method

- Long-context case: the real working session `ses_f27957eabffeL2gvNLCEnm02gW`
  (**645 messages, 6,068,031 chars persisted**) — real work, real tool calls.
- Mid-length case: `real-workload-bench` (file reads + analysis, ~40k chars).
- Short cases: one-line prompt sessions.
- Instrumentation (all in plugin storage, bounded):
  `diag:directive:<sid>` (queue → context → http-* event sequence, instance id),
  `diag:injected:<sid>` (actual `tools[]` names, advisor presence, format, sentinel).
- In-band canaries: `NATIVECANARY` (proved replaced request bodies ARE dispatched).

## Results

| # | Condition | Directive delivered | Executor consulted |
|---|---|---|---|
| 1 | Short context, trigger word | yes | **yes** |
| 2 | Mid context, `/advisor` command, MID-system injection | yes (system array) | **no** — model answered solo |
| 3 | Same session, `/advisor`, TRAILING-system injection | yes | **yes** |
| 4 | **6M-char session**, trigger word, trailing-system | yes (visible in TUI) | **yes** |
| 5 | 3× fresh `/advisor` command probes (post-random-marker) | yes | **3/3 yes** |
| 6 | Grant + trivial task ("use advisor if stuck. 2+2?") | grant recognized | **no** (correct restraint) |
| 7 | Non-trigger questions | none | **no** (correct) |

### Key findings

1. **`event.system` mutations (context hook) never reach the model on v2.0.16.**
   Proven with an in-band canary: pushed system text never appeared in replies.
   The native `http.request` body rewrite is the working channel — replacing
   `event.request` IS dispatched (NATIVECANARY appeared as the first token).
2. **Placement matters.** Mid-system injection failed on the mid-length real
   session; trailing system message (adjacent to generation) succeeded on the
   same session — the A/B is recorded above (#2 vs #3).
3. **`advisor` absent from direct `tools[]` is BY DESIGN** (Code Mode):
   plugin tools surface through `execute`'s catalog; the user's own
   subagent-delegate tools behave identically. `pinned: true` did NOT change
   it — reverted to the minimal registration shape. Consults work via
   `execute` anyway (4/4 post-fix).
4. **Role contamination on long contexts**: the first 6M-char consult made
   the advisor ECHO the executor's voice (it continued the transcript instead
   of advising). Fixed with an end-of-evidence marker + explicit
   "you are a different model; do not continue the executor's text" tail;
   the retry produced correct, grounded advice.
5. **Sentinel collision is real**: a static `<<advisor-plugin>>` marker
   appeared in this project's own transcripts (we discuss it!), silently
   disabling injection (`http-already`). Fixed with per-batch random markers
   `<<advisor-plugin:<rand>>`; the marker is now visible in live TUI sessions.
6. **Feedback-only return path GUARANTEED & tested**: the executor's tool
   result is only `ADVISOR REVIEW by <model>: <advice>` — word-capped
   (120 words default) — never transcript content (regression test:
   `GUARANTEE: the executor receives ONLY the framed advice`). One-way flow:
   transcript → advisor; advice → executor.

## Cost reference (for the "is a 700K dump expensive?" question)

GLM-5.3 on the price card: $1.40/M in · $4.40/M out · $0.26/M cache-read.

| Input size | Uncached | Cache-read |
|---|---:|---:|
| Our pruned default (~8K tok) | **$0.011** | — |
| 100K tok | $0.14 | $0.026 |
| 200K tok | $0.28 | $0.052 |
| 300K tok | $0.42 | $0.078 |
| 500K tok | $0.70 | $0.13 |
| 700K tok | **$0.98** | $0.182 |

Advisor output ~120 words ≈ 160 tokens ≈ $0.0007. Input dominates; pruning is
the lever (60–90× cheaper than dumps). Cache sheets help repeated calls on a
stable prefix; enable at 3+ expected calls per conversation.
