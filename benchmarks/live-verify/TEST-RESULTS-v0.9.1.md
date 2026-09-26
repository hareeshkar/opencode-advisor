# v0.9.1 full verification — results pointer

The authoritative 55-scenario matrix for the v0.9.1 live verification lives in
**[`REGRESSION-0.8.0.md`](./REGRESSION-0.8.0.md)**, section **"v0.9.1 full verification (55 scenarios + F8 flagship)"**
(the plan's own line 10 named this file; the operator mandate named `REGRESSION-0.8.0.md`, so the matrix was written
there and this stub points at it — divergence recorded as N-1 in that report).

Harness used for the run: [`v091/`](./v091/)
- `cfg.py` — atomic config write + sha256 before/after
- `reload.py` — asserts a new `loading plugin` burst after every write
- `snap.py` — usage ledger (UTC-keyed) + durable consult ledger reader/marker
- `preverify.mjs` — offline `resolveOptions` pre-flight before any paid consult
- `b_suite.mjs` — Suite B (free) · `gh_suite.mjs` — A6 + Suites G/H (free)
- `q.sh` — read-only sqlite helper
