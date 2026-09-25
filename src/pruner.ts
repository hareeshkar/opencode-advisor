/**
 * Transcript pruner — single-pass, O(total chars), zero allocations beyond
 * the output. Turns a raw session transcript into a high-signal, budgeted
 * excerpt for the advisor sub-call.
 *
 * Design goals (in priority order):
 *  1. Never exceed the char budget.
 *  2. Recency wins: the advisor most needs the CURRENT state.
 *  3. The original task is always present (pinned first).
 *  4. Tool outputs are the bloat source — head+tail truncation preserves
 *     both the command and the outcome (errors live at the tail).
 *  5. Deterministic: same input → same output (testability, caching).
 */

import type { PruneOptions, PruneStats, Slice } from "./types.js"

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const WHITESPACE_RUNS = /\n{3,}/g

/** Output patterns that carry near-zero advisor signal. */
const NOISE_PATTERNS: RegExp[] = [
  /^\s*(npm|yarn|pnpm|bun)\s+(warn|deprecated)/im,
  /^\s*(added|removed|changed|upgraded)\s+\d+\s+packages?\s+in\s+/m,
  /^\s*node_modules\/\S+\.(js|ts|map|json)(:\d+)?:/m,
  /\d+%\s*\|[^|\n]{0,60}\|\s*\d+\/\d+/m, // progress bars
  /^\s*(tracing|debugging|ready in|compiled successfully|watching for file changes)/im,
  /^\s*(> |$)\s*$/m, // bare repl echoes
]

/** Strip ANSI escapes and collapse whitespace runs. */
export function clean(text: string): string {
  return text.replace(ANSI, "").replace(WHITESPACE_RUNS, "\n\n").trim()
}

/** Fraction of lines matching noise patterns above which a slice is dropped. */
const NOISE_LINE_THRESHOLD = 0.6

function isNoise(text: string): boolean {
  let hits = 0
  let lines = 0
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    lines++
    for (const re of NOISE_PATTERNS) {
      if (re.test(line)) {
        hits++
        break
      }
    }
  }
  return lines > 0 && hits / lines >= NOISE_LINE_THRESHOLD
}

/** Head+tail truncation with an explicit elision marker. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.45)
  const tail = Math.floor(maxChars * 0.25)
  const elided = text.length - head - tail
  return `${text.slice(0, head)}\n…[elided ${elided} chars]…\n${text.slice(text.length - tail)}`
}

function label(slice: Slice): string {
  switch (slice.role) {
    case "user":
      return "[user]"
    case "assistant":
      return "[assistant]"
    default:
      return `[tool:${slice.name ?? "unknown"}]`
  }
}

export interface PruneResult {
  text: string
  stats: PruneStats
}

export function pruneTranscript(slices: readonly Slice[], opts: PruneOptions): PruneResult {
  const started = Date.now()
  const inChars = slices.reduce((n, s) => n + s.text.length, 0)

  let dropped = 0
  let truncated = 0

  // Pass 1: clean, drop noise/empties, truncate oversized slices.
  type Prepared = { slice: Slice; body: string; keepFull: boolean }
  const prepared: Prepared[] = []
  for (const s of slices) {
    const body = clean(s.text)
    if (body === "") continue
    if (s.role === "tool" && isNoise(body)) {
      dropped++
      continue
    }
    const cap = s.role === "tool" ? opts.maxToolOutputChars : opts.maxToolOutputChars * 2
    const body2 = body.length > cap ? (truncated++, truncateMiddle(body, cap)) : body
    prepared.push({ slice: s, body: body2, keepFull: s.role === "user" })
  }

  // Pass 2: assemble from the most recent context backwards under budget.
  const budget = opts.transcriptBudgetChars
  const lines: string[] = []
  let used = 0
  for (let i = prepared.length - 1; i >= 0; i--) {
    const p = prepared[i]!
    const line = `${label(p.slice)} ${p.body}`
    if (used + line.length <= budget || lines.length === 0) {
      lines.unshift(line)
      used += line.length
    } else {
      dropped++
    }
  }

  // Pass 3: pin the original task (first user slice) if it fell out of budget.
  const firstUser = prepared.find((p) => p.slice.role === "user" && p.keepFull)
  if (firstUser && !lines.some((l) => l.startsWith("[user]") && l.includes(firstUser.body.slice(0, 40)))) {
    const pinned = `[original task] ${truncateMiddle(firstUser.body, Math.min(firstUser.body.length, 2_000))}`
    if (used + pinned.length > budget && lines.length > 0) {
      // evict the oldest assembled line to make room
      const evicted = lines.shift()
      used -= evicted?.length ?? 0
      dropped++
    }
    lines.unshift(pinned)
    used += pinned.length
  }

  const text = lines.join("\n\n")
  return {
    text,
    stats: {
      inChars,
      outChars: text.length,
      droppedSlices: dropped,
      truncatedSlices: truncated,
      elapsedMs: Date.now() - started,
    },
  }
}
