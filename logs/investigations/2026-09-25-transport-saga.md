# Investigation — Session-Routed Transport & Model Selection

**Date:** 2026-09-25 (afternoon)
**Status:** RESOLVED — full E2E working (executor opencode-go/deepseek-v4-flash → advisor opencode-go/deepseek-v4.1-flash)
**Repo commits:** up to `9b49f2c`

## Problem

`ctx.generate.text` advisor sub-calls to opencode-go models failed with:
`Request is missing x-opencode-session and cannot be routed efficiently.`

## Root causes found (in order)

1. **Transient global calls carry no session.** `ctx.generate.text` is
   sessionless: no session hooks fire for it (proven: `httpHookLive=true`
   but `kinds=[primary]` only — the sub-call's native request never passed
   the hook), and no session headers attach. `RequestOptions.headers` only
   controls the client→server RPC, NOT server→provider (verified by failure
   persisting with headers set).
2. **An unproven hook can hang setup.** `await ctx.session.hook("http.request")`
   never resolved in this host version → setup hung → tool vanished from ALL
   new sessions with zero error output. Fix: race-guard EVERY unproven hook
   registration with a 5s timeout (now a project rule).
3. **`session.generate` is session-scoped and hook-visible.** Both
   `http.request` and `model.request` fire with `kind=generate`; nonce
   correlation works (`nonceMatches=1`); native session headers attach.
4. **`session.generate` assembles session tools** (recursion risk is real —
   the executor-model-as-advisor emitted `<execute><call>tools.advisor()`
   as text). Fix: `generate`-kind hook strips `event.tools={}` on exact
   nonce match + prompt rule 4 ("no tools, plain text only").
5. **Model selection cannot use `model.request`.** Assigning `event.model`
   is runtime-ignored (readonly enforced or pre-resolved). Proven by
   narration-text success where a honored swap would have run the advisor.
6. **switchModel sandwich works.** Bogus-id probe → `Model unavailable:
   opencode-go/__probe_bogus__`. Safety: the session blocks on the tool
   result, so no competing request can interleave; original model tracked
   via context hook (+session.get fallback), restored in `finally`.

## Evidence chain (all live, no restarts)

- Header refusal → Go docs (`x-opencode-session` requirement) → header
  attempt → still refused → diag tail (`httpHookLive/kinds/mrKinds/
  nonceMatches/stripped/seen/hist/pending`) → transport pivot →
  nonce match → empty text (tools assembled) → strip → narration text
  (executor-as-advisor) → sandwich → bogus rejection → real advisor
  advice (first true E2E, kimi executor + deepseek-v4.1-flash advisor).

## Design rules adopted

- R1: Never await an unproven host promise at setup without a timeout.
- R2: Every transport assumption gets a debug-observable canary
  (diag tail, history census, toolsSeen counter).
- R3: Trust boundaries stay sanitized in both directions (nonce regions,
  tools stripping, advice framing) even as transports change.
- R4: Prefer session-scoped primitives; global transient calls are
  second-class in this host (no hooks, no headers).

## Open (pre-benchmark)

- History pollution by session.generate: canary in place (`hist=` in
  diag); census the benchmark sessions post-run via message-list API.
- Prompt-caching benefit of explicit x-opencode-session: unmeasured.
- Upstream issue to file: generate.text should forward session headers
  or document its second-class status (anomalyco/opencode).
