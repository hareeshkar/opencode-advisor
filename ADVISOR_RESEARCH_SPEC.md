# Engineering Research Spec: Model-Agnostic OpenCode Advisor Plugin

**Role:** Senior Principal Engineer
**Status:** Discovery / Draft Architectural Plan
**Target Horizon:** Dual-Compatibility (OpenCode V1 & V2 Architecture)

---

## 1. Executive Summary & Core Objective

The primary objective is to build an open-source, **model-agnostic**, and token-efficient **Advisor Plugin** for the OpenCode ecosystem.

This plugin replicates the efficiency of **Claude Code's internal server-side orchestration** (where a high-performance executor like Claude 4.6 Sonnet calls a high-judgment advisor like Claude 4.7/5 Opus mid-generation) but strips away vendor lock-in. Our implementation must enable *any* fast base executor (e.g., DeepSeek Flash, Llama 3.3) to dynamically escalate complex, stuck contexts to *any* frontier model (e.g., GPT-4o, Claude Opus, GLM-5.2) without user intervention or token-bloating transcript pollution.

To guarantee institutional-grade stability, this specification provides a roadmap to research native provider behaviors via the internet and engineer a **two-tier abstraction layer** capable of supporting both OpenCode V1 and V2 runtime schemas simultaneously.

---

## 2. Deconstructing the Benchmark: How Claude Code Handles Advisors

To design a universal version, we must first deeply analyze how Anthropic implements this capability internally via their [Messages API Advisor Strategy](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool):

* **The Server-Side Tool Hook (`advisor_20260301`):** Anthropic wraps the execution loop inside a single API lifecycle using the `advisor-tool-2026-03-01` beta header. The client passes a special tool schema where `type: "advisor_20260301"`, declaring a specific target advisor model.
* **The Invisible Escalation:** When the executor model triggers the `advisor()` tool block, the transcript handoff happens entirely on Anthropic's backend. The advisor model consumes the existing context window and emits a condensed strategic correction (typically 400 to 700 tokens), which is injected right back into the executor's thread as an `advisor_tool_result`.
* **Asymmetric Token Cost Reductions:** By constraining the high-judgment model purely to strategic planning (leaving the low-level file edits, package management, and syntax output to the cheaper executor), the workflow realizes an approximate **12% cost drop per agentic task** while preserving or exceeding baseline frontier model correctness metrics (e.g., SWE-bench accuracy).
* **The "Plan Mode" Guardrail:** In standalone manual workflows, Claude Code uses a strict `plan` mode (invoked via `claude --permission-mode plan` or dual-tapping `Shift + Tab`). This drops tool permissions down to pure read-only states, forcing file exploration and architectural scaffolding into isolated planning spaces before writing a single block to disk.

---

## 3. Targeted Internet Research Protocol

We must actively leverage internet-facing tooling inside our terminal environment to unpack undocumented edge cases, SDK structures, and parsing configurations. Execute the following discovery queries to gather real-time data:

### Phase A: API Overhear & Tool Mapping
* **Search Context:** Look up how modern compatibility proxies capture the Anthropic advisor blocks.
  * *Query:* `"advisor_20260301" site:github.com/vercel/ai`
  * *Query:* `"advisor-tool-2026-03-01" litellm implementation`
* **Goal:** Extract exactly how the tool requests and responses are nested in upstream SDKs so we can emulate the payload schemas.

### Phase B: OpenCode V1 vs. V2 Lifecycle Interceptions
* **Search Context:** Research the change logs and feature requests for tracking multi-agent tool loops.
  * *Query:* `"opencode" "advisor" issue site:github.com`
  * *Query:* `"opencode" v2 plugin validation schema "plugins"`
* **Goal:** Confirm the raw Hook definitions (`onToolError`, `onCommand`, or interceptor boundaries) exposed by the V2 compiler compared to V1 core architecture.

---

## 4. The Engineering Blueprint: Dual-Version Support Architecture

Supporting both legacy OpenCode V1 runtimes and the next-generation OpenCode V2 engine requires an asymmetric abstraction layer. The plugin must detect its environment at startup and shift its orchestration engine accordingly.

### 4.1 Comparative Architecture Matrix

| Architectural Vector | OpenCode V1 Paradigm | OpenCode V2 Paradigm |
| :--- | :--- | :--- |
| **Configuration Keys** | Single string/tuple mapping: `"plugin": ["oc-advisor"]` | Standardized object array: `"plugins": [{"package": "..."}]` |
| **Context Strategy** | Explicit manual append to global conversation array. | Context-isolated subagents via project-level `AGENTS.md`. |
| **Plugin File Paths** | Evaluates legacy `.opencode/plugin/` paths. | Standardized plural discovery inside `.opencode/plugins/`. |
| **Permissions Enforcer** | Soft-coded validation loops in JS. | Hard native layer drops (e.g., `{ "action": "shell", "effect": "deny" }`). |

---

## 5. Execution Steps for "Plan Mode" Exploration

As Senior Principal Engineers, we will establish an **Exploratory Plan Mode Pipeline** inside our development system. This allows the plugin to map dependencies cleanly before triggering the advisor model:

```
┌────────────────────────────────────────┐
│       Executor Model Hits a Roadblock  │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Intercept via Plugin Lifecycle Hook   │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│    Spawn Transient Read-Only Subagent  │
│        (Downgrade system write access) │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Stream Pruned Token Context to Advisor│
│ (Prune heavy logs/keep structural delta)│
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Advisor Emits Dense Strategy Blueprint│
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Inject Strategy to Executor Loop &   │
│        Destroy Child Context           │
└────────────────────────────────────────┘
```

### Step 1: Context Isolation and Pruning
The plugin must intercept the execution stack prior to network dispatch. It will scan the active buffer, stripping away bloated terminal responses (such as `node_modules` installations, redundant stack traces, or binary dumps) to construct a high-signal file-diff snapshot.

### Step 2: Enforcing Read-Only Execution Guarantees
To prevent the Advisor from accidentally trying to invoke local shell operations, the plugin wrapper will programmatically append a system override payload. In V1, this is done via string-based prompt wrapping; in V2, it uses native system-level boundary schemas.

### Step 3: Serverless Handoff Simulation
Because we are provider-agnostic, we cannot depend on an upstream server to run our handoffs. Our plugin will establish a lightweight local router using OpenCode's internal Vercel AI SDK runtime to orchestrate the downstream calls across independent LLM providers cleanly.

---

## 6. Next Steps & Phase 1 Deliverables

1. **Verify Token Pruning Latency:** Test how fast our local script pulls context histories without polluting main session buffers.
2. **Implement Schema Router:** Draft a TypeScript wrapper that maps standard configuration inputs to both V1 and V2 object trees gracefully.
3. **Run Vendor Evaluation Matrix:** Benchmark a cheap provider combination (e.g., DeepSeek-Flash acting as Executor + Claude 3.5 Sonnet acting as Advisor) to record our cost-to-performance curve.
