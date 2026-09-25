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

/** Strip ANSI escapes, Unicode format controls (bidi, isolates, zero-width, BOM)
 * and C0/C1 codes except tab/newline/CR; collapse whitespace runs.
 * Property escapes keep this source 100% ASCII — no invisible characters. */
export function clean(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/\p{Cc}/gu, (ch) => (ch === "\t" || ch === "\n" || ch === "\r" ? ch : ""))
    .replace(WHITESPACE_RUNS, "\n\n")
    .trim()
}

/**
 * Forged slice labels: evidence content containing a line like "[user] ..."
 * would impersonate executor turns once we add our own labels. Neutralize by
 * quoting such lines; our own labels are added afterwards and stay canonical.
 */
const FORGED_LABEL = /^\[(transcript|original task|user|assistant|tool:[^\]\n]{0,80})\]/gim

function neutralizeLabels(body: string): string {
  return body.replace(FORGED_LABEL, "> [$1]")
}

/**
 * Opaque-blob heuristic (base64 dumps, minified single-token runs): long,
 * whitespace-poor, >92% base64-alphabet. Such slices consume budget with
 * zero advisor signal. Normal code (whitespace, punctuation, keywords)
 * never trips it.
 */
function isBlob(text: string): boolean {
  if (text.length < 300) return false
  const compact = text.replace(/\s+/g, "")
  if (compact.length < 300) return false
  const b64 = compact.match(/[A-Za-z0-9+/=]/g)
  return b64 !== null && b64.length / compact.length > 0.92
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
    const body = neutralizeLabels(clean(s.text))
    if (body === "") continue
    if (s.role === "tool" && isNoise(body)) {
      dropped++
      continue
    }
    if (s.role === "tool" && isBlob(body)) {
      dropped++
      continue
    }
    const cap = s.role === "tool" ? opts.maxToolOutputChars : opts.maxToolOutputChars * 2
    const body2 = body.length > cap ? (truncated++, truncateMiddle(body, cap)) : body
    prepared.push({ slice: s, body: body2, keepFull: s.role === "user" })
  }

  // Pass 2: assemble from the most recent context backwards under budget.
  // O(n): push newest→oldest, then reverse once. `used` tracks the exact
  // final byte length including "\n\n" separators, so the budget is a hard
  // invariant, not an approximation.
  const SEP = 2 // "\n\n".length
  const budget = opts.transcriptBudgetChars
  const out: string[] = []
  let used = 0
  let firstUserKept = false
  for (let i = prepared.length - 1; i >= 0; i--) {
    const p = prepared[i]!
    const line = `${label(p.slice)} ${p.body}`
    const cost = line.length + (out.length > 0 ? SEP : 0)
    if (used + cost <= budget || out.length === 0) {
      out.push(line)
      used += cost
      if (p.slice.role === "user" && p.keepFull) firstUserKept = true
    } else {
      dropped++
    }
  }

  // Pass 3: pin the original task (first user slice) if it fell out of budget.
  // Evict oldest lines until the pin fits; truncate the pin itself as a last
  // resort. Every evicted line is newly excluded → counted as dropped.
  const firstUser = prepared.find((p) => p.slice.role === "user" && p.keepFull)
  if (firstUser && !firstUserKept) {
    let pinned = `[original task] ${truncateMiddle(firstUser.body, Math.min(firstUser.body.length, 2_000))}`
    while (out.length > 0 && used + SEP + pinned.length > budget) {
      const evicted = out.pop() as string
      used -= evicted.length + SEP
      dropped++
    }
    const sep = out.length > 0 ? SEP : 0
    if (used + sep + pinned.length > budget) {
      pinned = truncateMiddle(pinned, Math.max(80, budget - used - sep))
    }
    used += sep + pinned.length
    out.push(pinned)
  }

  out.reverse()
  const text = out.join("\n\n")
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
