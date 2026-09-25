# Phase A — API Overhear & Tool Mapping (Anthropic Advisor)

**Date:** 2026-09-25
**Status:** COMPLETE — primary sources fetched
**Scope:** Reverse-engineer the native Anthropic advisor mechanics so we can emulate the payload schemas client-side.

---

## 1. Verdict

The advisor tool is **real, documented, and in beta**. It is Anthropic-native and server-side only on the Anthropic API. Third-party executors (OpenAI, Bedrock, Vertex, Groq, Mistral…) are only supported through **client-side orchestration loops** — exactly the architecture our plugin must replicate inside OpenCode. LiteLLM has already shipped such a loop (`AdvisorOrchestrationHandler`), which is our reference implementation.

---

## 2. Native mechanics (source of truth: platform.claude.com)

### 2.1 Request shape

```
POST /v1/messages
Headers:
  anthropic-version: 2023-06-01
  anthropic-beta:    advisor-tool-2026-03-01     <-- required beta header
Body:
  model:   <executor model>          e.g. claude-sonnet-5
  tools: [
    {
      type:      "advisor_20260301",  <-- literal type string
      name:      "advisor",           <-- must be exactly "advisor"
      model:     "<advisor model>",   <-- e.g. claude-opus-5
      max_uses?: <int>,               <-- per-REQUEST cap (default unlimited)
      max_tokens?: <int>,             <-- advisor output cap, MIN 1024
      caching?:  { type: "ephemeral", ttl: "5m" | "1h" }   <-- off by default
    }
  ]
```

### 2.2 Lifecycle (single `/v1/messages` request)

1. Executor decides to call `advisor` like any other tool.
2. Executor emits a **`server_tool_use`** block: `{ type: "server_tool_use", id: "srvtoolu_...", name: "advisor", input: {} }` — **input is always empty**; the server constructs the advisor's view from the full transcript (system prompt, tool definitions, prior turns + tool results, and the executor's in-flight text).
3. Anthropic runs a **separate sub-inference** on the advisor model, server-side. The advisor runs **without tools and without context management**; its thinking blocks are dropped; only advice text (typically **400–700 tokens**) returns.
4. Result returns to the executor as an **`advisor_tool_result`** block in the same assistant content array.
5. Executor continues generating, informed by the advice.

### 2.3 Result variants (discriminated union on `content.type`)

| Variant | Fields | Returned when |
|---|---|---|
| `advisor_result` | `text`, `stop_reason?` | Plaintext advisors (e.g. claude-opus-4-8) |
| `advisor_redacted_result` | `encrypted_content`, `stop_reason?` | Encrypted advisors (Opus 5, Fable 5/5.1, Mythos 5/5.1) — server decrypts into the executor's prompt next turn |
| `advisor_tool_result_error` | `error_code` | Failed sub-inference; executor continues without advice; **request does not fail** |

**Error codes:** `max_uses_exceeded`, `too_many_requests`, `overloaded`, `prompt_too_long`, `execution_time_exceeded`, `model_not_found`, `unavailable`.

Multi-turn rule: round-trip result blocks **verbatim**; the beta header must still be sent even if the tool is dropped from `tools` while history contains advisor blocks.

### 2.4 Paused turns

`stop_reason: "pause_turn"` can end a response with a pending advisor call (server_tool_use present, no result). Resume = re-send with unchanged assistant content; pending call runs at start of next request. Omitting the tool while a call is pending → 400.

### 2.5 Nudge (under-calling executors)

- Inject a short user-message reminder before assistant turn 2 if no advisor call yet.
- **Haiku executors: +~7pp pass rate.** Sonnet: no measurable effect. **Opus: slightly negative — do not nudge Opus.**
- `NUDGE_TURN = 2` is the documented default.

### 2.6 Caching (two independent layers)

- **Executor-side:** `advisor_tool_result` blocks are cacheable like any content block via `cache_control`.
- **Advisor-side:** tool-level `caching: {"type":"ephemeral","ttl":"5m"|"1h"}` is an on/off switch (server places breakpoints). Only worth it at **3+ advisor calls per conversation** (LiteLLM guidance).

### 2.7 Cost accounting

Sub-inference billed at advisor rates. Usage surfaces in `usage.iterations[]` entries with `type: "advisor_message"` (LiteLLM-compatible shape):

```json
"iterations": [
  { "type": "message",           "input_tokens": 412,  "output_tokens": 89 },
  { "type": "advisor_message", "model": "claude-opus-5", "input_tokens": 823, "output_tokens": 1612 },
  { "type": "message",           "input_tokens": 1348, "output_tokens": 442 }
]
```

Top-level usage reflects executor tokens only.

### 2.8 Model compatibility constraints (native path)

Advisor must be ≥ Sonnet 4.6 class and at least as capable as the executor; equal-capability peers can advise each other. Invalid pair → 400. **Platform availability: Anthropic API + Claude Platform on AWS only — NOT Bedrock/Vertex/Foundry.** Claude Managed Agents expose a roster-based `{"type":"advisor","model":...}` variant instead.

---

## 3. LiteLLM reference implementation (our blueprint)

Source: docs.litellm.ai/docs/completion/anthropic_advisor_tool

For non-Anthropic providers, LiteLLM's `AdvisorOrchestrationHandler` implements the loop client-side:

1. Detects `advisor_20260301` in `tools` + non-Anthropic provider → intercept.
2. **Strips** the advisor tool from the outgoing request; provider sees a **standard function tool named `advisor`**.
3. When executor calls it, intercepts **before the result reaches the caller**, runs the advisor sub-call, injects the advice as the tool result.
4. Strips `advisor_tool_result` / `server_tool_use` blocks from history on re-send so non-Anthropic providers never see Anthropic-specific types.
5. Wraps final response in SSE if `stream=True`. **Advisor sub-inference does not stream** — the executor's stream pauses, the full advice arrives in one event, then executor output resumes.
6. Enforces `max_uses` as a hard cap (`AdvisorMaxIterationsError`); `max_uses=0` disables.
7. Auto-adds the beta header on the Anthropic path; auto-strips advisor blocks from history when the tool is absent (prevents Anthropic 400s).
8. Usage reported via `provider_specific_fields` + `usage.iterations`.

Supported via the loop: OpenAI/Azure, Bedrock, Vertex, Groq, Mistral, others.

## 4. Vercel AI SDK status

- GitHub issue vercel/ai#18389: `feat(@ai-sdk/anthropic): forward maxTokens on advisor_20260301` — the SDK models the tool (min 1024; docs recommend 2048 starting point; caps advisor sub-inference) but forwarding of `max_tokens` was a tracked gap. **Implication:** for our Anthropic pass-through mode, verify the installed `@ai-sdk/anthropic` version forwards `max_tokens` on the advisor tool definition; otherwise set it via raw body overlay.

## 5. Claude Code integration findings

- Claude Code ≥1.100 injects `advisor-tool-2026-03-01` automatically; zero config for the user (zenn.dev write-up).
- **claude-code issue #46105:** with a custom `ANTHROPIC_BASE_URL` pointing at a third-party endpoint, the injected beta headers cause an immediate **HTTP 400**. → Hard evidence that the server-side advisor does not survive vendor substitution; a **client-side emulation layer** (our plugin) is the only way to get advisor behavior on non-Anthropic executors.
- Community cost analysis (yage.ai) and AlphaSignal note Anthropic's own evals used `max_uses: 3`.

---

## 6. Recommended prompts (verbatim from Anthropic docs — reuse in our plugin)

**Timing guidance (prepend to executor system prompt):**

> You have access to an `advisor` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.
>
> Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.
>
> Also call advisor:
> - When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change.
> - When stuck — errors recurring, approach not converging, results that don't fit.
> - When considering a change of approach.
>
> On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling.

**Advice weight guidance (append):**

> Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt. A passing self-test is not evidence the advice is wrong.
>
> If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?"

**Cost reduction (35–45% shorter advisor output, no quality loss):**

> The advisor should respond in under 100 words and use enumerated steps, not explanations.

---

## 7. Design implications for `opencode-advisor`

| Native behavior | Our client-side emulation |
|---|---|
| `server_tool_use{input:{}}` zero-arg semantics | Register a **zero-arg `advisor` tool** via `ctx.tool.transform` (V2) / `tool` map (V1) |
| Server builds advisor view from full transcript | Plugin reads `ctx.session.context({sessionID})`, **prunes**, renders into advisor prompt |
| Advisor runs tool-less, thought-dropped | Advisor call via `ctx.generate.text` (V2): no session, no tools, no history pollution; plain `fetch` (V1) |
| `advisor_tool_result` injection | Tool executor **returns** advice as tool result — flows back into executor turn natively |
| `max_uses` per request | Approximate per user-task via plugin storage counter, reset on prompt admission |
| Nudge (+7pp on small models) | `ctx.session.hook("context")` transient message injection, gated by executor tier config |
| `usage.iterations[]` accounting | Log advisor tokens to plugin storage + investigation logs |
| Beta header breakage on proxies | N/A — we never send Anthropic-specific types to non-Anthropic providers |

## 8. Errata vs. our spec (ADVISOR_RESEARCH_SPEC.md §2)

- CONFIRMED: tool type, beta header, empty input, 400–700 token advice, per-request `max_uses`, client-side conversation cap guidance.
- **Unverified:** the exact "~12% cost drop" figure (spec claim; Anthropic publishes a linked "Optimizing for cost and intelligence" page — bench it ourselves in the Vendor Matrix). Claude Code plan-mode specifics (`--permission-mode plan`, Shift+Tab) are Claude-Code client behavior, not advisor-API behavior — treat as inspiration only.
- Current-gen model naming in the wild: executors `claude-{haiku-4-5, sonnet-4-6, sonnet-5, opus-4-6…}`, advisors up to `claude-mythos-5-1` / `claude-fable-5-1`. The spec's "4.6 Sonnet / 4.7-5 Opus" naming is approximate.

## 9. Sources

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool (primary; quick start, params, variants, errors, nudge, caching, compatibility)
- https://docs.litellm.ai/docs/completion/anthropic_advisor_tool (orchestration loop, provider matrix, usage.iterations)
- https://github.com/vercel/ai/issues/18389 (AI SDK maxTokens forwarding)
- https://github.com/anthropics/claude-code/issues/46105 (beta header 400 on custom base URLs)
- https://github.com/BerriAI/litellm/issues/25516 (Vertex/advisor rollout verification)
