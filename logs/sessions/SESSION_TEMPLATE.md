# Error Session Dump — <TITLE>

> Copy this template for every failed/blocked session. One file per incident.
> Filename: `YYYY-MM-DD-<slug>.md`

| Field | Value |
|---|---|
| Date | |
| Component | plugin / host (V1/V2) / advisor provider / harness |
| OpenCode version | `opencode --version` |
| Plugin version | git rev or file mtime |
| Severity | blocker / major / minor |
| Status | open / mitigated / closed |

## Symptom

What was observed (exact error text, log lines, screenshot refs).

## Reproduction

Minimal steps, config snippets (redact secrets), model/provider pair involved.

## Evidence

- Log lines (`~/.local/share/opencode/log/opencode.log`, filter `role=server`):
- Session transcript excerpt (`sqlite3 "file:~/.local/share/opencode/opencode.db?mode=ro" ...`):
- Plugin storage state (kv table / `ctx.storage`):

## Root cause

Hypothesis → verification → conclusion. Cite the .d.ts line or doc page that proves it.

## Fix / workaround

Patch, config change, or version pin.

## Follow-ups

- [ ] items
