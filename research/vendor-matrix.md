# Vendor Evaluation Matrix — Executor × Advisor Pairs

**Date:** 2026-09-25
**Status:** FRAMEWORK READY — benchmark runs pending (Phase 1 Deliverable 3)

---

## 1. Provider capability matrix (who can run advisors today)

| Path | Executor | Advisor | Mechanism | Vendor lock-in |
|---|---|---|---|---|
| Anthropic native (`advisor_20260301`) | Claude only | Claude only (≥ Sonnet 4.6 class, ≥ executor) | Server-side sub-inference in one `/v1/messages` call | Full |
| LiteLLM gateway | Any (OpenAI, Bedrock, Vertex, Groq, Mistral…) | Claude advisors (Opus-class) | `AdvisorOrchestrationHandler` client-side loop | Gateway-dependent |
| Claude Code ≥1.100 | Claude | Claude | Native; breaks (HTTP 400) on custom `ANTHROPIC_BASE_URL` | Full |
| **opencode-advisor (ours)** | **Any OpenCode-configured provider** (DeepSeek, GLM, Llama, GPT, Gemini, Claude, local…) | **Any OpenCode-configured provider** | Plugin-side loop: zero-arg tool + `generate.text` sub-call + tool-result injection | **None** |

Key advantage: advisor routing uses **OpenCode's own provider registry** (`ctx.model.list()`), so credentials, base URLs, and proxies are already configured — the plugin adds zero networking config for V2.

## 2. Benchmark pairs (planned)

| Pair | Executor | Advisor | Thesis |
|---|---|---|---|
| A (baseline) | deepseek-v4-flash (free tier) | glm-5.2 | Zero-cost executor + frontier judgment; max cost delta |
| B | deepseek-v4-flash | claude-opus-4-8 (plaintext advisor) | Free executor + Anthropic judgment; cross-vendor |
| C | llama-3.3-70b (via OpenCode provider) | gpt-4o | Open-weights executor + OpenAI judgment |
| D | claude-haiku-4-5 | claude-opus-5 | Replicates Anthropic's documented pair; validates our loop vs native |
| E (control) | glm-5.3 solo / deepseek solo | — | No-advisor baseline for quality + cost comparison |
| F (control) | Advisor model solo | — | Advisor-solo quality ceiling |

Pair D is the calibration run: if our client-side loop ≈ native advisor quality at similar token spend, the emulation is sound.

## 3. Measurement methodology

Harness: scripted task set (see `plans/PHASE1_PLAN.md` §D3), each task run against each pair, artifacts dumped to `logs/sessions/`.

**Metrics per run**

1. `task_success` — binary rubric-graded outcome
2. `executor_in_tokens` / `executor_out_tokens` — session usage
3. `advisor_calls` — count (target: 1–3 per multi-step task, per Anthropic `max_uses: 3` evals)
4. `advisor_in_tokens` / `advisor_out_tokens` — sub-inference ledger (plugin storage)
5. `wall_clock_s` — end-to-end
6. `cost_total` = Σ(token_i × price_i) across both models
7. `prune_ratio` = advisor-visible chars / raw transcript chars (target ≤ 0.35)

**Cost model**

```
cost_task = executor_in·p_in(exec) + executor_out·p_out(exec)
          + Σ advisor_calls [ advisor_in·p_in(adv) + advisor_out·p_out(adv) ]
```

Advisor output budget: ≤ 700 tokens (docs-typical 400–700; prompt-enforced "<100 words, enumerated steps" cut 35–45% in Anthropic's tests).

**Comparison curves** (cost-to-performance):

- Pair X vs control E: Δquality / Δcost → advisor lift per dollar
- Pair X vs control F: fraction of advisor-solo quality achieved at executor-dominant cost
- Prune ablation: full transcript vs pruned → quality retained vs advisor input tokens saved

## 4. Acceptance thresholds (Phase 1 exit criteria)

| Metric | Target |
|---|---|
| Advisor lift (Pair A vs E) | ≥ +10pp task success on multi-step rubric |
| Cost vs advisor-solo (F) | ≤ 40% of F's cost |
| Prune latency (context pull → dispatch) | p95 ≤ 250ms for ≤ 200-message transcripts |
| Advisor advice length | 150–700 tokens, prompt-enforced |
| Zero transcript pollution | advisor sub-calls absent from persisted session history (verify via `session.context`) |

## 5. Open questions to resolve during benchmarks

1. Does `generate.text` honor per-call `maxTokens`-style options on all providers, or must the budget stay prompt-enforced? (test on anthropic/openai/deepseek/glm)
2. Nudge value on non-Anthropic small executors (DeepSeek-Flash ≈ Haiku-class?) — A/B `nudge.enabled`
3. Pruning aggressiveness vs advice quality — sweep `transcriptTokenBudget` ∈ {8k, 16k, 32k}
4. Cross-vendor advisor consistency (same task, advisors B/C/D) — variance of advice utility
