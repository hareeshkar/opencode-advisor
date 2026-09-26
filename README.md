# opencode-advisor

A manually invoked second opinion for OpenCode. Any executor model can consult any advisor model mid-task, under strict token budgets, with zero transcript pollution.

## What is this?

opencode-advisor is a plugin for OpenCode. While one model does your task (the executor), you can ask a different model you choose (the advisor) to review the work and give a second opinion. The advisor answers inside the same conversation, and it runs only when you ask — never on its own. It pairs a fast executor with a stronger reviewer through the providers you already have configured.

## Why this exists

Advisor review is a known pattern. Anthropic has published guidance on using a stronger model as an advisor to a faster executor, and this plugin generalizes that pattern into an inspectable mechanism that is not tied to any vendor.

It works with any model pair. You pick the advisor from OpenCode's live model catalog, on any provider, and any model can be the executor. The advisor reference uses the same structure as OpenCode's own catalog, so there is no vendor lock-in.

It has a frugal contract. The advisor spends only when you explicitly ask, through the /advisor command, a trigger word in a request, or a direct plain-language ask. There are no autonomous calls, no nudges, and no deferred permissions, ever.

Configuration is file-as-truth. Settings live in a plain JSON file (global and per project), and the settings menu and your hand edits change the same file, so the two cannot drift. A project file beats the global one, which means a repository can pin its own reviewer.

Budgets are token-native. Input context and output advice are separate ceilings, denominated in the unit models actually bill in, with hard caps: context up to 1,000,000 tokens and advice 500 to 64,000.

There are two investigation modes. Review sends the pruned conversation for advice; Review + Agent additionally lets the advisor verify your actual files read-only.

And the advisor sub-call is history-less by construction. It receives only a pruned excerpt of your conversation, never the session's own context, and the calling session's model is never switched.

## Try it in three steps

First, install the plugin (see Install below). A fresh install has no advisor model configured and spends nothing. Second, run /advisor-settings in OpenCode. Third, pick a model and Save.

That is everything required. The recommended Balanced preset, Review mode, the response wait, the consult ceiling, and timeouts are pre-tuned, so the next consult works immediately. From then on, ask in plain language ("get a second opinion on this plan") or run /advisor with an optional focus.

## The contract: manual-only

The executor defaults to its best solo work. The advisor never fires on its own, and nothing is spent in the background: a consultation happens only when you ask for one.

There are three ways to ask. The /advisor command takes an optional focus and is registered automatically on V2. Trigger words in your message (advice, advisor, get consultation — configurable through the triggers key) route a request for consultation, while a mere mention or a permission for later use does not spend. And a direct plain-language ask works too, because the executor recognizes a request when it sees one.

## How a consultation works

When you ask, the executor calls the zero-parameter advisor tool. The plugin prunes the conversation: the original task is pinned first, recent context wins, low-signal output is dropped, long tool output is truncated head and tail, and the result is bounded by the context budget in a single deterministic pass.

The advisor then runs. In Review mode it receives the pruned evidence in one provider call. In Review + Agent mode it runs as a read-only child session that may inspect the implicated files before advising.

The advice comes back framed, as ADVISOR REVIEW by provider/model, so the executor weighs it as peer opinion, credits the model when it uses it, and continues.

Two clocks govern every consult. The response wait (advisorResponseWaitMs, 90 seconds by default) is how long the executor's tool call blocks for a normal answer. The consult ceiling (maxConsultMs, one hour by default) is how long the consultation may live in total. If the advisor needs longer than the response wait, the tool returns ADVISOR CONSULT RUNNING — with a consult id and the promise that you do not need to start another consultation — the consult keeps running in the background, and the framed advice is delivered automatically on the executor's next turn. The advisor_status tool lists this session's consults (running, completed, failed) and replays delivered advice.

Launch failures are different. An unroutable provider, a bad key, or an unknown model fails immediately with advisor_not_running and a reason. A wait window never masks a launch failure.

Boundary rules: only the pruned evidence leaves your session, the full transcript never does, and nothing returns to the executor except the framed advice or a one-line error. Consultation is read-only. One unit caveat: four characters per token underestimates code-heavy transcripts, so near-ceiling context budgets can overshoot cost while staying safe on overflow.

## The four knobs: model, preset, mode, limits

The model is who advises. It uses the same structure as OpenCode's catalog reference: a provider id, a model id, and an optional variant. Pick one from your live catalog in /advisor-settings, or set it in JSON. With no model configured, nothing spends.

The preset is how much the advisor may use. One word expands to consults per task, context tokens, and advice tokens.

Economy is one consult per task with 8K context tokens and 4K advice tokens. Balanced, the recommended default, is three consults per task with 16K context tokens and 8K advice tokens. Thorough is five consults per task with 32K context tokens and 16K advice tokens. Exhaustive is eight consults per task with 64K context tokens and 32K advice tokens.

Patience is uniform across presets. Every preset waits 90 seconds for a synchronous answer and allows a one-hour consult ceiling. Presets scale budget, never patience; both numbers are configurable globally through the reference keys below.

If the effective quantities no longer match any preset, the menu shows Custom. Custom is computed from the effective values and never stored, so the row cannot lie about the mix. Picking a preset snaps the three quantities back.

The mode is how the advisor investigates. Review sends the pruned conversation for compact advice and is the fastest, most economical default. Review + Agent treats the conversation as the map: the advisor runs as a read-only child session that verifies the implicated files (the territory) before advising. The stored value is agent; review-agent is accepted as an alias, and Review remains the default.

Limits are the fine print: the response wait, the consult ceiling, consults per task, context tokens, advice tokens, the per-tool output cap, the retry ceiling, and the log level. Two of them deserve care.

The response wait (advisorResponseWaitMs) is how long the executor's tool call waits for advice before continuing in the background. The wait is not a kill switch; on expiry the consult continues and delivers automatically. It ranges from 100 to 600,000 milliseconds.

The consult ceiling (maxConsultMs) is the maximum advisor lifetime, from 1,000 to 86,400,000 milliseconds (a number or a size string such as "3.6m"). Expiry marks the consult failed with advisor_not_running and does not consume the consult cap.

A trade-off worth knowing: advice re-enters the executor's context and is re-paid on later turns until compaction, so Exhaustive advice can add around 32K tokens to that task. Raise it knowingly. The retry ceiling counts transport attempts per task and is never extra paid consults, so a throttled provider cannot add credits.

## Install

### OpenCode V2 (verified path)

The plugin entry must point at a directory (verified against v2.0.16; a flat file is rejected with a log message). index.js is the server plugin and tui.js is the CLI plugin that powers the native /advisor-settings menu, so keep them next to each other.

```sh
git clone https://github.com/hareeshkar/opencode-advisor
cd opencode-advisor && npm run build
mkdir -p ~/.config/opencode/opencode-advisor
cp dist/opencode-advisor.js ~/.config/opencode/opencode-advisor/index.js
cp dist/tui.js              ~/.config/opencode/opencode-advisor/tui.js
```

Running npm run install:local from the repository does the build and the same two copies. Plugin directories are hot-watched, so no restart is required. Register the plugin; a fresh install has no advisor model and costs nothing.

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "./opencode-advisor" }]
}
```

### Configure your advisor (one choice)

Picking a model is the only required setup step. The recommended Balanced preset, Review mode, the response wait, the consult ceiling, and timeouts are pre-tuned. Run /advisor-settings in OpenCode: the menu edits the model, the preset, the mode, and the limits; Save writes the config file atomically and applies immediately, with no restart on V2.

A declarative alternative is the plugin's options entry in opencode.json.

```jsonc
{
  "plugins": [{
    "package": "./opencode-advisor",
    "options": { "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3", "variant": "high" } }
  }]
}
```

Model ids are listed by opencode models (or /models in the TUI). V2 hot-reloads the config; restart only on V1 or builds without plugin hot-reload.

### OpenCode V1 (experimental)

The same bundle answers the older server() entrypoint automatically. V1 has no transient-generation primitive, so advisor sub-calls go directly to a provider endpoint and require a source.

```jsonc
"plugin": [["./plugins/opencode-advisor.js", {
  "advisor": { "providerID": "x", "id": "y" },
  "source": { "kind": "openai-compatible", "baseURL": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY", "model": "deepseek-chat" }
}]]
```

On V1, copy commands/advisor.md and commands/advisor-settings.md into ~/.config/opencode/commands/ (or your project's .opencode/commands/).

## Worked examples

A stronger reviewer for one repo. Put this in the project's .opencode/opencode-advisor.json.

```json
{
  "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3", "variant": "high" },
  "preset": "thorough",
  "advisorMode": "review-agent"
}
```

Inside this repository, every consult goes to glm-5.3 with the Thorough budget (five consults per task, 32K context tokens, 16K advice tokens) and Review + Agent verification: the advisor receives the pruned conversation as its map and verifies the implicated files read-only before advising. Other repositories keep the global setup. The project file beats the global one, and while you are inside this repository /advisor-settings edits it.

Frugal everywhere. Put this in the global file.

```json
{
  "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3" },
  "preset": "economy",
  "advisorMode": "review"
}
```

Economy is one consult per task with an 8K context budget and 4K advice tokens; Review is the default mode, stated here for clarity. A project file can still add or override any key.

## Configuration files

Configuration is file-as-truth: a plain JSON file that you or the menu edit is the only place settings are stored. The global file lives at ~/.config/opencode/opencode-advisor.json. The project file lives at .opencode/opencode-advisor.json inside the repository (canonical) or as opencode-advisor.json at the project root (a convenience alias; the canonical location wins if both exist).

Precedence, highest wins: the project file, then the global file, then the opencode.json plugin options, then ADVISOR_* environment variables, then built-in defaults.

The /advisor-settings menu reads the file when it opens and writes it atomically on Save. Nothing is written until Save, Cancel discards, and Inherit removes a key rather than freezing today's value. Manual JSON edits win, and the next menu open reflects them. Save targets an existing project file when there is one, otherwise the global file. Config edits hot-reload on V2, so changes apply without a restart.

### Reference

| Key | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| advisor | model ref | none | { providerID, id, variant? }, non-empty values | The model that advises. Unset means unconfigured, zero spend |
| preset | enum | balanced (implied) | economy / balanced / thorough / exhaustive | How much the advisor may use: consults per task, context tokens, advice tokens |
| advisorMode | enum | review | review, agent (review-agent and review+agent accepted) | Review = advice from the pruned conversation; agent = Review + Agent, read-only file verification |
| maxUsesPerTask | number | preset (3) | 1–50 | Successful consults per user task; a safety cap |
| maxAttempts | number | 3 × consults + 2 (11) | 1–100 | Transport attempts per task — never extra paid consults |
| advisorResponseWaitMs | ms | 90000 | 100–600,000 | How long the tool call waits for advice before continuing in the background (the advisor keeps running). timeoutMs accepted as a deprecated alias |
| maxConsultMs | ms (number or size) | 3600000 | 1,000–86,400,000 | Maximum advisor lifetime; expiry fails the consult without consuming the cap |
| adviceTokenBudget | tokens (number) | preset (8,000) | 500–64,000 | Advisor output tokens — the reply length cap |
| transcriptBudgetTokens | tokens (number or size) | preset (16,000) | 2,000–1,000,000 | Input context tokens sent to the advisor (about four characters per token for the pruner) |
| maxToolOutputChars | chars (number or size) | 1500 | 100–200,000 | Characters kept from a single tool output |
| triggers | string list | advice, advisor, get consultation | non-empty strings; an empty list disables | Words that route a consult request; a mere mention never spends |
| logLevel | enum | info | debug / info / warn / error | Plugin diagnostics verbosity |
| source | object | none | V1 only: kind (anthropic or openai-compatible), baseURL, apiKeyEnv, model, optional extraHeaders | Direct provider endpoint for the V1 adapter |

Notes on these keys. The files are strict JSON: no comments and no trailing commas (opencode.json is JSONC and allows both). transcriptBudgetTokens and maxToolOutputChars accept a number or a 1000-based size string such as "32k" or "1.5m"; adviceTokenBudget and advisorResponseWaitMs are plain numbers, and maxConsultMs also accepts a size string ("3.6m"). If the context budget is smaller than the per-tool cap it is raised to match, with a warning, because a smaller budget cannot hold a meaningful excerpt. The response wait is clamped to the consult ceiling.

Environment variables: ADVISOR_PROVIDER, ADVISOR_MODEL, ADVISOR_VARIANT, ADVISOR_MAX_USES, ADVISOR_LOG, ADVISOR_MODE, and ADVISOR_SOURCE_KIND, ADVISOR_SOURCE_URL, ADVISOR_SOURCE_KEY_ENV, ADVISOR_SOURCE_MODEL.

## Worked examples

A stronger reviewer for one repository. Place this in the project's .opencode/opencode-advisor.json.

```json
{
  "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3", "variant": "high" },
  "preset": "thorough",
  "advisorMode": "review-agent"
}
```

Inside this repository every consult goes to glm-5.3 with the Thorough budget (five consults per task, 32K context tokens, 16K advice tokens) and Review + Agent verification: the advisor receives the pruned conversation as its map and verifies the implicated files read-only before advising. Other repositories keep the global setup. The project file beats the global file, and while you are inside this repository /advisor-settings edits it.

Frugal everywhere. Place this in the global file.

```json
{
  "advisor": { "providerID": "zai-coding-plan", "id": "glm-5.3" },
  "preset": "economy",
  "advisorMode": "review"
}
```

Economy is one consult per task with an 8K context budget and 4K advice tokens; Review is the default mode, stated here for clarity. A project file can still add or override any key.

## Troubleshooting

No advisor model is configured. Fresh installs are intentionally unconfigured and spend nothing. Run /advisor-settings and pick a model; that is the only required choice and it applies immediately. The tool answers with the same setup steps for the executor to relay, so nothing is invented.

A load error names a config file. The plugin never falls back silently on invalid configuration. The message includes the file path and the problem, for example a preset outside the allowed set. Fix the JSON at that path; the files are strict JSON with no comments and no trailing commas (opencode.json is JSONC and allows both).

Advice is too long, too short, or cut off. Tune the output budget with adviceTokenBudget (500 to 64,000 tokens). Model output caps are typically 8K to 65K tokens.

The advisor seems to be missing context. Raise transcriptBudgetTokens, or lower maxToolOutputChars if a single tool output crowds the budget.

Spend is higher than expected. Advice re-enters the executor's context and is re-paid on later turns until compaction, so Exhaustive advice can add around 32K tokens to a task. Prefer Economy or Balanced, or lower adviceTokenBudget.

The tool said ADVISOR CONSULT RUNNING. The advisor needed longer than the response wait, so the consult continued in the background and the framed advice is delivered automatically on the executor's next turn. The advisor_status tool lists progress and replays delivered advice. Never start another consultation for the same question.

The result said advisor_not_running. Two cases: a launch failure (an unroutable provider, a bad key, or an unknown model — these fail immediately in seconds) or the consult ceiling expired. Neither consumes the consult cap. Retry, or fix the provider, or raise the ceiling.

A read-only session named "advisor consult" appears in the session list. That is the Review + Agent child session. Plugins cannot delete sessions (a platform limitation), so it can remain after the consult; it is inert, and you can delete it manually.

How to reset everything. /advisor-settings, then Reset all settings, removes the plugin's keys from the file the menu edits (an existing project file, otherwise the global file). Other keys in that file are untouched; deleting the file works too.

## Questions

Why is there no autonomous mode? By design. Only an explicit request spends credits, so the plugin can never surprise you with a bill. There is no nudge, no timing heuristic, and no deferred permission to remember: a message that merely mentions the advisor, or grants future use, does not call it.

What does a consult cost? One call to the advisor model, bounded by your budgets: at most the context budget of input (Balanced: 16K tokens) and the advice budget of output (Balanced: 8K tokens). The advice then re-enters the executor's context and is re-paid on later turns until compaction. Rates depend on your provider.

Does the advisor see my whole conversation? No. It sees a pruned excerpt: the original task pinned first, the most recent context, low-signal output dropped, long tool output truncated, and prior advisor replies excluded. In Review + Agent it also reads the implicated files, read-only. The sub-call never carries your session history.

What happens if the advisor model fails? The failure is classified (timeout, rate limit, model not found, context too long, unavailable) and returned to the executor as a one-line error; the executor proceeds. Failures never consume the consult cap, and the retry ceiling bounds transport attempts, not paid consults. If a backgrounded consult fails after the tool returned, a one-line notice is delivered the same way the advice would have been.

Can I use different advisors per project? Yes. The project file wins over the global one, and /advisor-settings edits whichever exists for the repository you are in.

Do I need to restart after changing settings? Not on OpenCode V2. Save writes atomically and applies immediately; config edits from your editor are picked up on the next consult. Restart only on V1 or builds without plugin hot-reload.

Does anything persist between restarts? Your config file, always. The consult ledger (the last hundred consults, used by advisor_status) is in memory by design and never contains prompts, so a restart clears history but never settings.

## Unconfigured installs cost nothing

A fresh install ships with no advisor model and registers the tool anyway. If anything calls it, the tool returns a not_configured message carrying the setup steps (run /advisor-settings and pick a model, or set the declarative options entry) for the executor to relay. It never invents advice, and it never dispatches a paid request.

## Advice hygiene

The executor receives only the framed advice, as ADVISOR REVIEW by provider/model followed by the text. The transcript never comes back with it. Advice is peer opinion: the executor weighs it and credits the source model when it uses it. Prior advisor replies and trailing in-flight drafts are excluded from future consult evidence, so consultations cannot imitate or compound themselves. Consultation is read-only: Review touches nothing, and Review + Agent reads implicated files with read-only tools in a child session.

## Development

npm install, then npm run typecheck for the strict type check, npm test for the test suite (161 tests green), and npm run build for the bundles. The installable artifacts are the two files in dist/. Design notes and prior art live in the research directory, and working documents live in plans.

Current version: 0.8.1. Zero runtime dependencies.

## License

MIT. Copyright 2026 hareeshkar.
